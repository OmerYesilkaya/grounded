import {
  fieldLabel,
  reviewRecord,
  type ChecklistMark,
  type ReviewAnchor,
  type ReviewedAssignment,
} from "@grounded/core";
import type { Block } from "@grounded/content";
import {
  and,
  asc,
  assignments,
  eq,
  inArray,
  isNull,
  reviewComments,
  reviewMessages,
  reviews,
  sql,
  type Db,
} from "@grounded/db";
import type { AssignmentRow } from "./assignments.js";
import { publish } from "./events.js";
import type { JobQueue } from "./queue.js";

/*
 * Reviews of handed-in homework and arc exams (design §7.4): margin comments where the learner's
 * model leaked, with their threads, and the checklist marked. The review's events go on the log of
 * the session that assigned it, which the assignment's page follows:
 *
 *   review           { assignmentId, …ReviewView }   started, done or failed: all of it as it now is
 *   review-message   { assignmentId, commentId, id, role, text, blocks }   a reply, or its answer
 *   review-delta     { commentId, replyTo, text }   the answer to a reply, as it streams
 *   review-resolved  { assignmentId, commentId, resolvedAt }   the leak is resolved
 */

export type ReviewRow = typeof reviews.$inferSelect;

export interface ReviewMessageView {
  id: string;
  role: "learner" | "tutor";
  text: string;
  blocks: Block[] | null;
}

export interface ReviewCommentView {
  id: string;
  anchor: ReviewAnchor;
  items: string[];
  resolvedAt: string | null;
  messages: ReviewMessageView[];
}

/** A review as the assignment's page sees it. */
export interface ReviewView {
  id: string;
  status: ReviewRow["status"];
  failure: string | null;
  checklist: ChecklistMark[];
  comments: ReviewCommentView[];
}

/** The comments of these reviews, in order, each with its thread. */
async function commentsOf(db: Db, reviewIds: readonly string[]) {
  if (reviewIds.length === 0) return [];
  const comments = await db
    .select()
    .from(reviewComments)
    .where(inArray(reviewComments.reviewId, [...reviewIds]))
    .orderBy(asc(reviewComments.position));
  const messages = comments.length
    ? await db
        .select()
        .from(reviewMessages)
        .where(
          inArray(
            reviewMessages.commentId,
            comments.map((c) => c.id),
          ),
        )
        .orderBy(asc(reviewMessages.createdAt), asc(reviewMessages.id))
    : [];
  return comments.map((comment) => ({
    ...comment,
    messages: messages.filter((m) => m.commentId === comment.id),
  }));
}

/** The assignment's review; null before it was handed in. */
export async function loadReview(db: Db, assignmentId: string): Promise<ReviewView | null> {
  const [row] = await db.select().from(reviews).where(eq(reviews.assignmentId, assignmentId));
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    failure: row.failure,
    checklist: row.checklist,
    comments: (await commentsOf(db, [row.id])).map((c) => ({
      id: c.id,
      anchor: c.anchor,
      items: c.items,
      resolvedAt: c.resolvedAt?.toISOString() ?? null,
      messages: c.messages.map(({ id, role, text, blocks }) => ({ id, role, text, blocks })),
    })),
  };
}

/** Publishes the review as it now is, on the log of the session that assigned it. */
export async function publishReview(db: Db, assignment: AssignmentRow): Promise<void> {
  const review = await loadReview(db, assignment.id);
  if (review)
    await publish(db, assignment.sessionId, "review", { assignmentId: assignment.id, ...review });
}

/**
 * Starts the review of a handed-in assignment (design §7.4: review starts on submit), or starts a
 * failed one again: the review job is queued. False when it is already under way or done.
 */
export async function startReview(
  db: Db,
  queue: JobQueue,
  assignment: AssignmentRow,
): Promise<boolean> {
  const [row] = await db
    .insert(reviews)
    .values({ assignmentId: assignment.id })
    .onConflictDoUpdate({
      target: reviews.assignmentId,
      set: { status: "reviewing", failure: null, updatedAt: sql`now()` },
      where: eq(reviews.status, "failed"),
    })
    .returning({ id: reviews.id });
  if (!row) return false;
  await publishReview(db, assignment);
  await queue.enqueue("review", { sessionId: assignment.sessionId, assignmentId: assignment.id });
  return true;
}

/** Adds a message to a comment's thread and publishes it: a reply, or the tutor's answer to it. */
export async function recordReviewMessage(
  db: Db,
  assignment: Pick<AssignmentRow, "id" | "sessionId">,
  commentId: string,
  message: { role: "learner" | "tutor"; text: string; blocks?: Block[] | null },
): Promise<ReviewMessageView> {
  const [row] = await db
    .insert(reviewMessages)
    .values({ commentId, role: message.role, text: message.text, blocks: message.blocks ?? null })
    .returning();
  if (!row) throw new Error("review message insert returned nothing");
  const view = { id: row.id, role: row.role, text: row.text, blocks: row.blocks };
  await publish(db, assignment.sessionId, "review-message", {
    assignmentId: assignment.id,
    commentId,
    ...view,
  });
  return view;
}

/**
 * Marks leaks resolved (design §7.4): by the learner, in the comment's card (`inSession` null), or
 * by a later session's review, which carried them on (#40). A leak resolved already stays as it was.
 */
export async function resolveLeaks(
  db: Db,
  commentIds: readonly string[],
  inSession: string | null,
): Promise<void> {
  if (commentIds.length === 0) return;
  const resolved = await db
    .update(reviewComments)
    .set({ resolvedAt: sql`now()`, resolvedInSession: inSession })
    .where(and(inArray(reviewComments.id, [...commentIds]), isNull(reviewComments.resolvedAt)))
    .returning({
      id: reviewComments.id,
      reviewId: reviewComments.reviewId,
      at: reviewComments.resolvedAt,
    });
  for (const comment of resolved) {
    const [owner] = await db
      .select({ id: assignments.id, sessionId: assignments.sessionId })
      .from(reviews)
      .innerJoin(assignments, eq(assignments.id, reviews.assignmentId))
      .where(eq(reviews.id, comment.reviewId));
    if (!owner) continue;
    await publish(db, owner.sessionId, "review-resolved", {
      assignmentId: owner.id,
      commentId: comment.id,
      resolvedAt: comment.at?.toISOString() ?? null,
    });
  }
}

/** A done review of an assignment as other calls read it (reviewRecord); null if there is none. */
export async function reviewedAssignment(
  db: Db,
  assignment: AssignmentRow,
): Promise<ReviewedAssignment | null> {
  const [row] = await db
    .select()
    .from(reviews)
    .where(and(eq(reviews.assignmentId, assignment.id), eq(reviews.status, "done")));
  if (!row) return null;
  const comments = await commentsOf(db, [row.id]);
  return {
    title: assignment.title,
    kind: assignment.kind,
    checklist: assignment.checklist,
    marks: row.checklist,
    comments: comments.map((c) => ({
      field: labelIn(assignment, c.anchor),
      quote: c.anchor.quote,
      messages: c.messages.map(({ role, text }) => ({ role, text })),
      resolved: c.resolvedAt !== null,
    })),
  };
}

/** The label of the field an anchor is in, with its task's title where the assignment has several. */
export function labelIn(assignment: Pick<AssignmentRow, "tasks">, anchor: ReviewAnchor): string {
  const task = assignment.tasks.find((t) => t.id === anchor.taskId);
  if (!task) return anchor.field;
  const label = fieldLabel(task.form, anchor.field);
  return task.title ? `${label} (${task.title})` : label;
}

/** The heading a session's reviews go under in the close's prompt and the teaching notes'. */
export const HOMEWORK_REVIEWED = "The review of what they handed in";

/**
 * The reviews of what a session assigned, for a prompt (the close, the teaching notes); null when
 * none is reviewed yet.
 */
export async function sessionReviewRecord(db: Db, sessionId: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(assignments)
    .where(eq(assignments.sessionId, sessionId))
    .orderBy(asc(assignments.createdAt), asc(assignments.id));
  const records: string[] = [];
  for (const row of rows) {
    const reviewed = await reviewedAssignment(db, row);
    if (reviewed) records.push(reviewRecord(reviewed));
  }
  return records.length ? records.join("\n\n") : null;
}

/** A leak still open: a comment on the track's reviewed work that no card or later review resolved. */
export interface OpenLeak {
  commentId: string;
  assignment: Pick<AssignmentRow, "id" | "title" | "kind" | "sessionId">;
  /** The answer field's label, as the learner saw it. */
  field: string;
  quote: string;
  messages: { role: "learner" | "tutor"; text: string }[];
}

/**
 * The track's open leaks (design §7.4: unresolved leaks carry into the next session's review): an
 * arc exam's first, as the review takes an exam first (method.md, "Review"), then oldest first.
 * What #40's review phase reads, and resolves with resolveLeaks once it has dealt with them.
 */
export async function openLeaks(db: Db, trackId: string): Promise<OpenLeak[]> {
  const rows = await db
    .select({ id: reviewComments.id, reviewId: reviews.id, assignment: assignments })
    .from(reviewComments)
    .innerJoin(reviews, eq(reviews.id, reviewComments.reviewId))
    .innerJoin(assignments, eq(assignments.id, reviews.assignmentId))
    .where(
      and(
        eq(assignments.trackId, trackId),
        eq(reviews.status, "done"),
        isNull(reviewComments.resolvedAt),
      ),
    )
    .orderBy(
      sql`${assignments.kind} = 'exam' desc`,
      asc(assignments.createdAt),
      asc(assignments.id),
      asc(reviewComments.position),
    );
  const comments = await commentsOf(db, [...new Set(rows.map((r) => r.reviewId))]);
  return rows.flatMap(({ id, assignment }) => {
    const comment = comments.find((c) => c.id === id);
    if (!comment) return [];
    const { title, kind, sessionId } = assignment;
    return [
      {
        commentId: id,
        assignment: { id: assignment.id, title, kind, sessionId },
        field: labelIn(assignment, comment.anchor),
        quote: comment.anchor.quote,
        messages: comment.messages.map(({ role, text }) => ({ role, text })),
      },
    ];
  });
}

/**
 * The track's open leaks for a prompt, each labelled L1, L2…, for the call to name the ones it
 * resolved; `labels` maps them back to comment ids. Null when none is open.
 */
export async function openLeaksRecord(
  db: Db,
  trackId: string,
): Promise<{ text: string; labels: Map<string, string> } | null> {
  const leaks = await openLeaks(db, trackId);
  if (leaks.length === 0) return null;
  const labels = new Map<string, string>();
  const text = leaks
    .map((leak, i) => {
      const label = `L${String(i + 1)}`;
      labels.set(label, leak.commentId);
      const what = leak.assignment.kind === "exam" ? "arc exam" : "homework";
      const where = leak.quote ? `«${leak.quote}» in ${leak.field}` : leak.field;
      const thread = leak.messages.map(
        (m) => `  ${m.role === "learner" ? "Learner" : "Tutor"}: ${m.text}`,
      );
      return [
        `${label}: in their ${what} "${leak.assignment.title}", on ${where}:`,
        ...thread,
      ].join("\n");
    })
    .join("\n\n");
  return { text, labels };
}
