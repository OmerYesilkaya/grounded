import type { LanguageModelV4 } from "@ai-sdk/provider";
import {
  answersMarkdown,
  assignmentRecordSchema,
  type AssignmentKind,
  type AssignmentRecord,
  type AssignmentTask,
  type ChecklistItem,
  type TaskForm,
  bare,
} from "@grounded/core";
import {
  parseBlocks,
  splitLessonSteps,
  validate,
  type Block,
  type Inline,
  type TrackTerm,
} from "@grounded/content";
import { and, asc, assignments, eq, inArray, isNull, ne, submissions, type Db } from "@grounded/db";
import { generateText, Output, type Instructions, type ModelMessage } from "ai";
import { log } from "../log.js";
import { traced, verdictIssues } from "./call-trace.js";
import { publish } from "./events.js";
import type { JobQueue } from "./queue.js";
import { applyEvent, loadSession, RejectedEvent } from "./session-store.js";

/*
 * Homework and arc exams (design §7.4): what a session assigns, kept as an assignment of its own
 * that outlives the session. Its events go on the log of the session that assigned it, so the chat
 * and the assignment's page both hear them:
 *
 *   assignment  { id, kind, title, messageId, submittedAt, snoozedUntil, subsumedBy }
 *               assigned, or changed (handed in, snoozed, folded into a later homework)
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
    snoozedUntil: row.snoozedUntil?.toISOString() ?? null,
    subsumedBy: row.subsumedBy,
  };
}

/**
 * Why an assignment can't be changed any more, or null while it is open: handed in, or folded into
 * a later homework.
 */
export function closedReason(row: Pick<AssignmentRow, "submittedAt" | "subsumedBy">) {
  if (row.submittedAt) return bare("handed-in");
  if (row.subsumedBy) return bare("folded-into-later");
  return null;
}

/**
 * The track's homework still open, oldest first: neither handed in nor folded into a later one.
 * The next homework subsumes it (method.md, "Homework").
 */
export function openHomeworkOf(db: Db, trackId: string) {
  return db
    .select()
    .from(assignments)
    .where(
      and(
        eq(assignments.trackId, trackId),
        eq(assignments.kind, "homework"),
        isNull(assignments.submittedAt),
        isNull(assignments.subsumedBy),
      ),
    )
    .orderBy(asc(assignments.createdAt), asc(assignments.id));
}

/** The heading the track's open homework goes under in the homework's prompt. */
export const OPEN_HOMEWORK = "Homework the learner put off, still open";

/**
 * The track's open homework, for the homework call (method.md, "Homework": the next homework
 * subsumes an open one): each one's task as the learner read it, what a good answer demonstrates,
 * and what they have written so far. The session's own homework isn't among them. Null when none is
 * open.
 */
export async function openHomeworkRecord(
  db: Db,
  trackId: string,
  sessionId: string,
): Promise<string | null> {
  const open = (await openHomeworkOf(db, trackId)).filter((row) => row.sessionId !== sessionId);
  if (open.length === 0) return null;
  const written = await db
    .select()
    .from(submissions)
    .where(
      inArray(
        submissions.assignmentId,
        open.map((row) => row.id),
      ),
    );
  const parts = open.map((row) => {
    const answers = written.find((s) => s.assignmentId === row.id)?.answers ?? {};
    const started = Object.values(answers).some((answer) =>
      Object.values(answer?.fields ?? {}).some((text) => text.trim() !== ""),
    );
    return [
      `### "${row.title}"`,
      row.tasks.map((task) => task.source).join("\n\n"),
      `What a good answer demonstrates:\n${row.checklist.map((item) => `- ${item.text}`).join("\n")}`,
      started
        ? `What they have written so far:\n\n${answersMarkdown(row.tasks, answers)}`
        : "They haven't written anything for it yet.",
    ].join("\n\n");
  });
  return [
    "The homework you write now takes the place of these: design it so that it also covers their ground, rebuilt on what this session added, not as a second task beside it (they are folded into it and closed once it is kept). Don't mention them by name or point back at them; the task stands alone.",
    ...parts,
  ].join("\n\n");
}

/**
 * "Later" with a snooze (design §7.4): the homework is due again at `until`. Null when it was
 * closed meanwhile (handed in, or folded into a later one).
 */
export async function snoozeAssignment(
  db: Db,
  assignment: AssignmentRow,
  until: Date,
): Promise<AssignmentRow | null> {
  const [row] = await db
    .update(assignments)
    .set({ snoozedUntil: until })
    .where(
      and(
        eq(assignments.id, assignment.id),
        isNull(assignments.submittedAt),
        isNull(assignments.subsumedBy),
      ),
    )
    .returning();
  if (row) await publishAssignment(db, row);
  return row ?? null;
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
  // Words before an exam's first part go with it, under its heading.
  const lead = parts[0]?.[0]?.type === "heading" ? [] : (parts.shift() ?? []);
  const sources = kind === "exam" ? splitLessonSteps(message.text) : [];
  const whole = kind !== "exam" || sources.length < 2 || sources.length !== parts.length;
  if (whole) {
    const form = forms[0] ?? "explain";
    return [
      { id: "t1", title: null, form, blocks: [...message.blocks], source: message.text.trim() },
    ];
  }
  const leadText = message.text.slice(0, message.text.indexOf(sources[0] ?? "")).trim();
  return parts.map((blocks, i) => {
    const [heading, ...rest] = blocks;
    const source = sources[i] ?? "";
    return {
      id: `t${String(i + 1)}`,
      title: heading?.type === "heading" ? plain(heading.children).trim() : null,
      form: forms[i] ?? forms.at(-1) ?? "explain",
      // The heading is shown as the task's title, not again in its text.
      blocks: i === 0 ? [...lead, ...rest] : rest,
      source: i === 0 && leadText ? `${leadText}\n\n${source}` : source,
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
      if (inline.type === "cite") return "";
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
 * Each record's verdict is stored on its call (call-trace.ts).
 */
export async function recordAssignment(options: {
  model: LanguageModelV4;
  system: Instructions;
  /** The conversation up to and including the assignment's message. */
  messages: ModelMessage[];
  request: string;
  terms: readonly TrackTerm[];
}): Promise<AssignmentRecord> {
  const ask = (feedback: ModelMessage[]) =>
    traced(async () => {
      const { output } = await generateText({
        model: options.model,
        system: options.system,
        output: Output.object({ schema: assignmentRecordSchema }),
        messages: [...options.messages, { role: "user", content: options.request }, ...feedback],
      });
      return output;
    });
  const first = await ask([]);
  const problems = recordProblems(first.value, options.terms);
  await first.judge({ rewrite: 0, issues: verdictIssues(problems) });
  if (problems.length === 0) return first.value;
  log.info({ problems: problems.length }, "assignment record broke rules; asking again");
  const again = await ask([
    { role: "assistant", content: JSON.stringify(first.value) },
    {
      role: "user",
      content: `That record broke these rules; send it again, fixed:\n${problems.map((p) => `- ${p}`).join("\n")}`,
    },
  ]);
  const still = recordProblems(again.value, options.terms);
  await again.judge({ rewrite: 1, issues: verdictIssues(still) });
  if (still.length > 0) log.warn("assignment record still breaks rules; keeping it");
  return again.value;
}

/**
 * The session that assigned this homework goes on once the learner hands it in or puts it off
 * (design §7.4): handed in, to the homework's review, which the close waits for (the review job
 * then moves it on, closeAfterReview); put off, to its close. True when it went on. A session
 * already past its homework (closed, say, after an earlier "Later") stays as it is; an exam never
 * holds its session.
 */
export async function closeAfterHomework(
  db: Db,
  queue: JobQueue,
  assignment: AssignmentRow,
  event: "homework-handed-in" | "homework-later",
): Promise<boolean> {
  const moved = await moveOn(db, assignment, "assigned", event);
  if (moved && event === "homework-later")
    await queue.enqueue("recap", { sessionId: assignment.sessionId });
  return moved;
}

/**
 * Once the homework's review is done, or has failed, the session that waited for it goes on to its
 * close (design §7.4): true when it did. A review of homework handed in after its session closed
 * moves nothing.
 */
export async function closeAfterReview(
  db: Db,
  queue: JobQueue,
  assignment: AssignmentRow,
): Promise<boolean> {
  const moved = await moveOn(db, assignment, "reviewing", "homework-reviewed");
  if (moved) await queue.enqueue("recap", { sessionId: assignment.sessionId });
  return moved;
}

/** Applies the event to the homework's session if it is waiting on the homework as `from` says. */
async function moveOn(
  db: Db,
  assignment: AssignmentRow,
  from: "assigned" | "reviewing",
  event: "homework-handed-in" | "homework-later" | "homework-reviewed",
): Promise<boolean> {
  if (assignment.kind !== "homework") return false;
  const { state } = await loadSession(db, assignment.sessionId);
  if (state.phase !== "homework" || state.homework !== from) return false;
  try {
    await applyEvent(db, assignment.sessionId, { type: event });
  } catch (error) {
    // Moved on meanwhile (the other button, in another tab): nothing more to do.
    if (error instanceof RejectedEvent) return false;
    throw error;
  }
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
  if (kind === "homework") await foldOpenHomework(db, kept);
  return kept;
}

/**
 * The next homework subsumes an open one (method.md, "Homework"): once it is kept, the track's
 * homework still open is folded into it, closed without being handed in. Its prompt was shown them
 * (`openHomeworkOf`); one handed in meanwhile stays handed in. Each one folded is published on the
 * log of the session that assigned it.
 */
async function foldOpenHomework(db: Db, into: AssignmentRow): Promise<void> {
  const folded = await db
    .update(assignments)
    .set({ subsumedBy: into.id })
    .where(
      and(
        eq(assignments.trackId, into.trackId),
        eq(assignments.kind, "homework"),
        ne(assignments.id, into.id),
        isNull(assignments.submittedAt),
        isNull(assignments.subsumedBy),
      ),
    )
    .returning();
  for (const row of folded) await publishAssignment(db, row);
}
