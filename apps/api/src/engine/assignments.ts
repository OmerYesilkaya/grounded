import type { LanguageModelV4 } from "@ai-sdk/provider";
import {
  assignmentRecordSchema,
  type AssignmentKind,
  type AssignmentRecord,
  type AssignmentTask,
  type ChecklistItem,
  type TaskForm,
} from "@grounded/core";
import {
  parseBlocks,
  splitLessonSteps,
  validate,
  type Block,
  type Inline,
  type TrackTerm,
} from "@grounded/content";
import { and, asc, assignments, eq, type Db } from "@grounded/db";
import { generateText, Output, type Instructions, type ModelMessage } from "ai";
import { log } from "../log.js";
import { publish } from "./events.js";
import type { JobQueue } from "./queue.js";
import { applyEvent, loadSession, RejectedEvent } from "./session-store.js";

/*
 * Homework and arc exams (design §7.4): what a session assigns, kept as an assignment of its own
 * that outlives the session. Its events go on the log of the session that assigned it, so the chat
 * and the assignment's page both hear them:
 *
 *   assignment  { id, kind, title, messageId, submittedAt }   assigned, or changed (handed in)
 */

export type AssignmentRow = typeof assignments.$inferSelect;

/** What the browser sees of an assignment in its session's chat and snapshot. */
export function assignmentSummary(row: AssignmentRow) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    messageId: row.messageId,
    submittedAt: row.submittedAt?.toISOString() ?? null,
  };
}

/** The assignments a session made, oldest first. */
export function sessionAssignments(db: Db, sessionId: string) {
  return db
    .select()
    .from(assignments)
    .where(eq(assignments.sessionId, sessionId))
    .orderBy(asc(assignments.createdAt), asc(assignments.id));
}

/** The session's assignment of this kind, if it has made one. */
export async function assignmentOf(
  db: Db,
  sessionId: string,
  kind: AssignmentKind,
): Promise<AssignmentRow | null> {
  const [row] = await db
    .select()
    .from(assignments)
    .where(and(eq(assignments.sessionId, sessionId), eq(assignments.kind, kind)))
    .limit(1);
  return row ?? null;
}

/** Publishes an assignment as it now is, on its session's log. */
export async function publishAssignment(db: Db, row: AssignmentRow): Promise<void> {
  await publish(db, row.sessionId, "assignment", assignmentSummary(row));
}

/**
 * The tasks of an assignment's message: homework is one task, the whole message; an exam is one
 * task per `##` part, each with its heading as its title. Each task gets the kind the record gave
 * it, in order (the last kind for any parts the record missed).
 */
export function tasksOf(
  kind: AssignmentKind,
  message: { text: string; blocks: readonly Block[] },
  forms: readonly TaskForm[],
): AssignmentTask[] {
  // The message's blocks as stored: their links already verified (design §6.4).
  const parts: Block[][] = [];
  for (const block of message.blocks) {
    const last = parts.at(-1);
    if (last && !(block.type === "heading" && block.depth === 2)) last.push(block);
    else parts.push([block]);
  }
  // Words before an exam's first part go with it.
  const [intro, next] = parts;
  if (intro && next && intro[0]?.type !== "heading") parts.splice(0, 2, [...intro, ...next]);
  const sources = kind === "exam" ? splitLessonSteps(message.text) : [];
  const whole = kind !== "exam" || sources.length < 2 || sources.length !== parts.length;
  const tasks = whole ? [[...message.blocks]] : parts;
  return tasks.map((blocks, i) => {
    const first = blocks[0];
    const title = !whole && first?.type === "heading" ? plain(first.children).trim() : null;
    return {
      id: `t${String(i + 1)}`,
      title,
      form: forms[i] ?? forms.at(-1) ?? "explain",
      // The heading is shown as the task's title, not again in its text.
      blocks: title === null ? blocks : blocks.slice(1),
      source: whole ? message.text.trim() : (sources[i] ?? ""),
    };
  });
}

/** Inline content as plain text: a heading's words. */
function plain(inlines: readonly Inline[]): string {
  return inlines
    .map((inline) => {
      if (inline.type === "strong" || inline.type === "emphasis" || inline.type === "link")
        return plain(inline.children);
      if (inline.type === "break") return " ";
      return inline.value;
    })
    .join("");
}

/** "What a good answer demonstrates", as items with ids, from the record. */
const checklistOf = (items: readonly string[]): ChecklistItem[] =>
  items
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text, i) => ({ id: `c${String(i + 1)}`, text }));

/** The record's problems, fed back to the call: an item that breaks the term list, none at all. */
function recordProblems(record: AssignmentRecord, terms: readonly TrackTerm[]): string[] {
  const problems: string[] = [];
  if (record.forms.length === 0) problems.push("Give the kind of each task.");
  if (checklistOf(record.checklist).length === 0)
    problems.push("List what a good answer demonstrates.");
  for (const item of record.checklist) {
    const issues = validate(parseBlocks(item).blocks, { surface: "homework", terms }).filter(
      (i) => i.severity !== "review",
    );
    for (const issue of issues) problems.push(`In "${item}": ${issue.message}`);
  }
  return problems;
}

/**
 * The structured record after an assignment's message (prose first, design §7.1): each task's
 * kind, a name, and what a good answer demonstrates. A record that breaks a rule is asked for again
 * once, with the problems; one still broken is kept (logged), since the learner has read the task.
 */
export async function recordAssignment(options: {
  model: LanguageModelV4;
  system: Instructions;
  /** The conversation up to and including the assignment's message. */
  messages: ModelMessage[];
  request: string;
  terms: readonly TrackTerm[];
}): Promise<AssignmentRecord> {
  const ask = async (feedback: ModelMessage[]) =>
    (
      await generateText({
        model: options.model,
        system: options.system,
        output: Output.object({ schema: assignmentRecordSchema }),
        messages: [...options.messages, { role: "user", content: options.request }, ...feedback],
      })
    ).output;
  const first = await ask([]);
  const problems = recordProblems(first, options.terms);
  if (problems.length === 0) return first;
  log.info({ problems: problems.length }, "assignment record broke rules; asking again");
  const again = await ask([
    { role: "assistant", content: JSON.stringify(first) },
    {
      role: "user",
      content: `That record broke these rules; send it again, fixed:\n${problems.map((p) => `- ${p}`).join("\n")}`,
    },
  ]);
  if (recordProblems(again, options.terms).length > 0)
    log.warn("assignment record still breaks rules; keeping it");
  return again;
}

/**
 * The session that assigned this homework goes on to its close once the learner hands it in or
 * puts it off (design §7.4): true when it did. A session already past its homework (closed, say,
 * after an earlier "Later") stays as it is; an exam never holds its session.
 */
export async function closeAfterHomework(
  db: Db,
  queue: JobQueue,
  assignment: AssignmentRow,
  event: "homework-handed-in" | "homework-later",
): Promise<boolean> {
  if (assignment.kind !== "homework") return false;
  const { state } = await loadSession(db, assignment.sessionId);
  if (state.phase !== "homework" || state.homework !== "assigned") return false;
  try {
    await applyEvent(db, assignment.sessionId, { type: event });
  } catch (error) {
    // Moved on meanwhile (the other button, in another tab): nothing more to do.
    if (error instanceof RejectedEvent) return false;
    throw error;
  }
  await queue.enqueue("recap", { sessionId: assignment.sessionId });
  return true;
}

/** Keeps a written assignment and publishes it on its session's log. */
export async function createAssignment(
  db: Db,
  input: {
    session: { id: string; trackId: string; userId: string };
    kind: AssignmentKind;
    message: { id: string; text: string; blocks: readonly Block[] };
    record: AssignmentRecord;
  },
): Promise<AssignmentRow> {
  const { session, kind, message, record } = input;
  const [row] = await db
    .insert(assignments)
    .values({
      trackId: session.trackId,
      sessionId: session.id,
      userId: session.userId,
      kind,
      title: record.title.trim(),
      tasks: tasksOf(kind, message, record.forms),
      checklist: checklistOf(record.checklist),
      messageId: message.id,
    })
    // A job tried again after the row was written finds it there (the message is unique).
    .onConflictDoNothing()
    .returning();
  const kept = row ?? (await assignmentOf(db, session.id, kind));
  if (!kept) throw new Error("assignment insert returned nothing");
  await publishAssignment(db, kept);
  return kept;
}
