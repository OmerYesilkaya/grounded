import {
  answerFields,
  answersMarkdown,
  assembleSystemPrompt,
  placeQuote,
  REVIEW_LIMITS,
  type Answers,
  type AssignmentReview,
  type ChecklistMark,
  type Method,
  type Reviewer,
  type ReviewAnchor,
} from "@grounded/core";
import {
  answerText,
  parseAnswer,
  parseBlocks,
  validate,
  type Block,
  type Issue,
  type TrackTerm,
} from "@grounded/content";
import { answerFiles, eq, submissions, type Db } from "@grounded/db";
import type { FilePart, ModelMessage, TextPart } from "ai";
import type { FileStore } from "../files/store.js";
import type { AssignmentRow } from "./assignments.js";
import { systemMessages } from "./call-options.js";
import { loadCheckRecord } from "./check-record.js";
import { loadSession } from "./session-store.js";
import { loadTrackContext } from "./track-state.js";

/*
 * What the review's calls read (design §7.4): the review phase's method, the track as it is now,
 * what the session that set the assignment saw at its checks, the tasks with what a good answer
 * demonstrates, and the learner's answers as they handed them in, their pictures included.
 */

/** The assignment as the review reads it: each task as the learner read it, then the checklist. */
function assignmentText(assignment: AssignmentRow): string {
  const tasks = assignment.tasks.map(
    (task, i) =>
      `## Task ${String(i + 1)} (${task.id})${task.title ? `: ${task.title}` : ""}\n\n${task.source}`,
  );
  const items = assignment.checklist.map((item) => `- ${item.id}: ${item.text}`);
  return [...tasks, `## What a good answer demonstrates\n\n${items.join("\n")}`].join("\n\n");
}

/** The learner's answers, handed in, as they were saved. */
export async function answersOf(db: Db, assignmentId: string): Promise<Answers> {
  const [row] = await db
    .select({ answers: submissions.answers })
    .from(submissions)
    .where(eq(submissions.assignmentId, assignmentId));
  return row?.answers ?? {};
}

/**
 * The answers as the opening turn of the review's conversation: their text with each field's key,
 * then each picture in them, as it is, after its link, so the model can tell which is which.
 */
async function answersTurn(
  db: Db,
  files: FileStore,
  assignment: AssignmentRow,
  answers: Answers,
): Promise<ModelMessage> {
  const markdown = answersMarkdown(assignment.tasks, answers);
  const what = assignment.kind === "exam" ? "arc exam" : "homework";
  const parts: (TextPart | FilePart)[] = [
    { type: "text", text: `(The learner handed in their ${what}. Their answers:)\n\n${markdown}` },
  ];
  const pictures = await db
    .select()
    .from(answerFiles)
    .where(eq(answerFiles.assignmentId, assignment.id));
  for (const picture of pictures) {
    const url = `/api/assignments/${assignment.id}/files/${picture.id}`;
    if (!markdown.includes(url)) continue;
    parts.push({ type: "text", text: `The picture at ${url}:` });
    parts.push({
      type: "file",
      data: await files.get(picture.storageKey),
      mediaType: picture.mediaType,
    });
  }
  return { role: "user", content: parts };
}

/** The review's system prompt, the learner's answers as its opening turn, and the terms it obeys. */
export async function reviewPrompt(options: {
  db: Db;
  files: FileStore;
  method: Method;
  assignment: AssignmentRow;
  /** More for the system prompt, after the assignment (a reply's comment). */
  extra?: { heading: string; body: string }[];
}) {
  const { db, assignment } = options;
  const track = await loadTrackContext(db, assignment.trackId, { phase: "review" });
  const session = await loadSession(db, assignment.sessionId);
  const checks = await loadCheckRecord(db, assignment.sessionId, session.state);
  const answers = await answersOf(db, assignment.id);
  const system = systemMessages(
    assembleSystemPrompt(options.method, "review", {
      ...track,
      extra: [
        ...(checks ? [{ heading: "What happened at the lesson's checks", body: checks }] : []),
        {
          heading: assignment.kind === "exam" ? "The arc exam" : "The homework",
          body: assignmentText(assignment),
        },
        ...(options.extra ?? []),
      ],
    }),
  );
  const opening = await answersTurn(db, options.files, assignment, answers);
  return { system, opening, answers, terms: track.current };
}

/** A comment as it is kept: where it hangs, the checklist items it bears on, and its words. */
export interface SettledComment {
  anchor: ReviewAnchor;
  items: string[];
  text: string;
  blocks: Block[];
}

export interface SettledReview {
  /** In the order of the answer: task, field, then where in the field. */
  comments: SettledComment[];
  marks: ChecklistMark[];
  /** What doesn't hold, in words for the call. */
  problems: string[];
}

/**
 * The review's output checked against the assignment and the answers (design §7.4): each comment
 * placed on the words it quotes, its words and the checklist's notes checked against the term list
 * like anything the learner reads, and every item marked. What doesn't hold is a problem, for the
 * call to fix once. Whatever is kept in the end still hangs somewhere: a quote the answer doesn't
 * have on its field as a whole, a task or field the assignment doesn't have on the first one.
 */
export async function settleReview(input: {
  output: AssignmentReview;
  assignment: AssignmentRow;
  answers: Answers;
  terms: readonly TrackTerm[];
  review: Reviewer;
}): Promise<SettledReview> {
  const { output, assignment, answers, terms } = input;
  const problems: string[] = [];
  const flagged: Issue[] = [];
  const written: string[] = [];
  const checked = (text: string, where: string) => {
    const parsed = parseBlocks(text);
    for (const issue of [
      ...parsed.issues,
      ...validate(parsed.blocks, { surface: "review", terms }),
    ])
      if (issue.severity === "review") flagged.push(issue);
      else problems.push(`${where}: ${issue.message}`);
    written.push(text);
    return parsed.blocks;
  };

  const placed = output.comments.slice(0, REVIEW_LIMITS.comments).flatMap((comment) => {
    const taskIndex = assignment.tasks.findIndex((t) => t.id === comment.task.trim());
    if (taskIndex === -1)
      problems.push(
        `A comment names the task "${comment.task}", which isn't one; use a task's id.`,
      );
    const task = assignment.tasks[Math.max(taskIndex, 0)];
    if (!task) return [];
    const fields = answerFields(task.form, answers[task.id]);
    let fieldIndex = fields.findIndex((f) => f.key === comment.field.trim());
    if (fieldIndex === -1) {
      problems.push(
        `A comment names the field "${comment.field}", which ${task.id} doesn't have; use a [field: …] key.`,
      );
      fieldIndex = 0;
    }
    const field = fields[fieldIndex];
    if (!field) return [];
    const text = answerText(parseAnswer(answers[task.id]?.fields[field.key] ?? ""));
    const at = placeQuote(text, comment.quote);
    if (comment.quote.trim() && !at)
      problems.push(
        `The quote "${comment.quote}" isn't in their ${field.key} as they wrote it: copy their words exactly, or leave the quote empty for the field as a whole.`,
      );
    const blocks = checked(comment.comment, `In the comment on "${comment.quote || field.label}"`);
    const anchor: ReviewAnchor = {
      taskId: task.id,
      field: field.key,
      quote: "",
      prefix: "",
      suffix: "",
      ...at,
    };
    const known = new Set(assignment.checklist.map((item) => item.id));
    return [
      {
        order: {
          task: Math.max(taskIndex, 0),
          field: fieldIndex,
          at: at ? text.indexOf(at.quote) : -1,
        },
        comment: {
          anchor,
          items: comment.items.filter((id) => known.has(id)),
          text: comment.comment.trim(),
          blocks,
        },
      },
    ];
  });
  placed.sort(
    (a, b) =>
      a.order.task - b.order.task || a.order.field - b.order.field || a.order.at - b.order.at,
  );

  const marks = assignment.checklist.flatMap((item): ChecklistMark[] => {
    const marked = output.checklist.find((m) => m.item.trim() === item.id);
    if (!marked) {
      problems.push(`Mark ${item.id} ("${item.text}") too.`);
      return [];
    }
    const note = marked.note.trim();
    if (note) checked(note, `In the note on ${item.id}`);
    return [{ id: item.id, mark: marked.mark, note }];
  });

  // What matching can't decide, judged together by the wording review (design §3.3).
  if (written.length > 0) {
    const judged = await input.review({
      markdown: written.join("\n\n"),
      flagged,
      terms,
      introduced: [],
    });
    problems.push(...judged.map((issue) => issue.message));
  }
  return { comments: placed.map((p) => p.comment), marks, problems };
}
