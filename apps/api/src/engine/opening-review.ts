import { asideRecord, reviewRecord, type SessionState } from "@grounded/core";
import {
  and,
  asideMessages,
  asides,
  asc,
  assignments,
  checkMessages,
  eq,
  inArray,
  isNull,
  learningSessions,
  lessons,
  reviews,
  sql,
  type Db,
} from "@grounded/db";
import { asThreads, loadAsides, stepNumber } from "./asides.js";
import { checkRecord } from "./check-record.js";
import { jobWaiting, type JobQueue } from "./queue.js";
import { reviewedAssignment } from "./reviews.js";

/*
 * The review that opens a session (design §7.1): before the probe, the session takes up what came
 * up since the last one. The reviews of handed-in work (an arc exam first) and the questions asked on
 * older lessons after their session closed are claimed by the session as it starts, each by one
 * session only (`taken_up_in`), so what comes after that waits for the next session; the steps the
 * last session continued past while still shaky are read from its state. When nothing waits, the
 * session opens with the probe.
 */

/** The heading what waits for the review goes under in its calls. */
export const REVIEW_WAITING = "What came up since the last session, for the review";

/** The heading what the review found goes under in the probe's and the plan's calls. */
export const REVIEW_FOUND = "What the opening review found (the learner hasn't seen this)";

/** Reviews of handed-in work no session has taken up: done, or still under way. */
const untakenOn = (trackId: string) =>
  and(
    eq(assignments.trackId, trackId),
    isNull(reviews.takenUpIn),
    inArray(reviews.status, ["done", "reviewing"]),
  );

/** Reviews and what they review, an arc exam's first (method.md, "Review"), then oldest first. */
const reviewsWhere = (db: Db, condition: ReturnType<typeof and>) =>
  db
    .select({ review: reviews, assignment: assignments })
    .from(reviews)
    .innerJoin(assignments, eq(assignments.id, reviews.assignmentId))
    .where(condition)
    .orderBy(
      sql`${assignments.kind} = 'exam' desc`,
      asc(assignments.createdAt),
      asc(assignments.id),
    );

type ReviewRows = Awaited<ReturnType<typeof reviewsWhere>>;

/**
 * Whether reviews leave the opening review something to take up: one still under way, an item
 * not held, or a comment still open in the margin.
 */
async function leaveSomething(db: Db, rows: ReviewRows): Promise<boolean> {
  for (const { review, assignment } of rows) {
    if (review.status === "reviewing") return true;
    if (review.checklist.some((m) => m.mark !== "held")) return true;
    const reviewed = await reviewedAssignment(db, assignment);
    if (reviewed?.comments.some((c) => !c.resolved)) return true;
  }
  return false;
}

/** The steps a lesson went past while still shaky (design §7.3). */
const settlingSteps = (state: SessionState) =>
  state.lesson.steps.filter((s) => state.steps[s.id]?.status === "settling").map((s) => s.id);

/** The track's sessions in order, each with its number on the track and its lesson's title. */
async function trackSessions(db: Db, trackId: string) {
  const rows = await db
    .select({
      id: learningSessions.id,
      state: learningSessions.state,
      closedAt: learningSessions.closedAt,
      outline: lessons.outline,
    })
    .from(learningSessions)
    .leftJoin(lessons, eq(lessons.sessionId, learningSessions.id))
    .where(eq(learningSessions.trackId, trackId))
    .orderBy(asc(learningSessions.createdAt), asc(learningSessions.id));
  return rows.map((row, i) => ({ ...row, number: i + 1 }));
}

type TrackSession = Awaited<ReturnType<typeof trackSessions>>[number];

/** The track's session closed last; null before the first closes. */
async function lastClosed(db: Db, trackId: string) {
  return (await trackSessions(db, trackId)).filter((s) => s.closedAt !== null).at(-1) ?? null;
}

/** "session 3's lesson "Why a counter loses updates"", as a record names a lesson. */
const lessonOf = (session: TrackSession) =>
  `session ${String(session.number)}'s lesson${session.outline?.title ? ` "${session.outline.title}"` : ""}`;

/** What came up on a track since its last session, for the next session to take up. */
export interface SinceLastSession {
  /** Something waits for the review: the session opens with it. */
  waiting: boolean;
  /** The reviews of handed-in work no session has taken up yet, done or under way. */
  reviewIds: string[];
  /** The questions asked on the track's older lessons, after their session closed, not taken up. */
  asideIds: string[];
}

/**
 * What came up on the track since its last session, asked before a session is made to choose its
 * opening: something waits for the review when a review of handed-in work no session has taken up
 * leaves something open, the learner asked on an older lesson, or the last session continued past a
 * step while still shaky.
 */
export async function sinceLastSession(db: Db, trackId: string): Promise<SinceLastSession> {
  const untaken = await reviewsWhere(db, untakenOn(trackId));
  const reviewIds = untaken.map((r) => r.review.id);
  // Asked, or followed up, after the lesson's session closed: its close didn't hear it.
  const asked = await db
    .selectDistinct({ id: asides.id })
    .from(asides)
    .innerJoin(learningSessions, eq(learningSessions.id, asides.sessionId))
    .innerJoin(asideMessages, eq(asideMessages.asideId, asides.id))
    .where(
      and(
        eq(learningSessions.trackId, trackId),
        isNull(asides.takenUpIn),
        eq(asideMessages.role, "learner"),
        sql`${asideMessages.createdAt} > ${learningSessions.closedAt}`,
      ),
    );
  const asideIds = asked.map((a) => a.id);
  const since = { reviewIds, asideIds };
  if (asideIds.length > 0 || (await leaveSomething(db, untaken)))
    return { waiting: true, ...since };
  const last = await lastClosed(db, trackId);
  return { waiting: last !== null && settlingSteps(last.state).length > 0, ...since };
}

/**
 * Takes up what came up in the session: its review goes over it (or, opening with the probe, there
 * was nothing in it to go over), and no later session's does.
 */
export async function claimForReview(
  db: Db,
  sessionId: string,
  { reviewIds, asideIds }: Omit<SinceLastSession, "waiting">,
): Promise<void> {
  if (reviewIds.length > 0)
    await db
      .update(reviews)
      .set({ takenUpIn: sessionId })
      .where(and(inArray(reviews.id, reviewIds), isNull(reviews.takenUpIn)));
  if (asideIds.length > 0)
    await db
      .update(asides)
      .set({ takenUpIn: sessionId })
      .where(and(inArray(asides.id, asideIds), isNull(asides.takenUpIn)));
}

/**
 * The handed-in work whose reviews the session's review took up, an arc exam first: the chat links
 * it, where the comments in its margin are.
 */
export async function takenUpBy(db: Db, sessionId: string) {
  const rows = await reviewsWhere(
    db,
    and(eq(reviews.takenUpIn, sessionId), eq(reviews.status, "done")),
  );
  return rows.map((r) => r.assignment);
}

/** Whether a review the session took up is still being written: its review waits for it. */
export async function reviewsUnderWay(db: Db, sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: reviews.id })
    .from(reviews)
    .where(and(eq(reviews.takenUpIn, sessionId), eq(reviews.status, "reviewing")))
    .limit(1);
  return row !== undefined;
}

/** What waits for a session's review, for its calls; `labels` maps the open leaks' labels to comments. */
export interface OpeningReviewRecord {
  text: string;
  labels: Map<string, string>;
}

/**
 * What waits for the session's review, for its calls: the reviews it took up, each item with its
 * mark and each comment with its thread, the leaks still open labelled L1, L2… for the review's
 * record to name; then the steps the last session continued past while still shaky, each with its
 * check thread. Null when nothing is left to take up (the learner found every flaw in the margin
 * meanwhile, say).
 */
export async function openingReviewRecord(
  db: Db,
  session: { id: string; trackId: string },
): Promise<OpeningReviewRecord | null> {
  const rows = await reviewsWhere(
    db,
    and(eq(reviews.takenUpIn, session.id), eq(reviews.status, "done")),
  );
  const labels = new Map<string, string>();
  const parts: string[] = [];
  let open = false;
  for (const { review, assignment } of rows) {
    const reviewed = await reviewedAssignment(db, assignment);
    if (!reviewed) continue;
    const comments = reviewed.comments.map((comment) => {
      if (comment.resolved) return comment;
      const label = `L${String(labels.size + 1)}`;
      labels.set(label, comment.id);
      return { ...comment, label };
    });
    if (review.checklist.some((m) => m.mark !== "held") || comments.some((c) => !c.resolved))
      open = true;
    parts.push(reviewRecord({ ...reviewed, comments }));
  }

  // Questions asked on older lessons after their session closed, lesson by lesson.
  const sessions = await trackSessions(db, session.trackId);
  const taken = await db
    .selectDistinct({ sessionId: asides.sessionId })
    .from(asides)
    .where(eq(asides.takenUpIn, session.id));
  for (const older of sessions.filter((s) => taken.some((a) => a.sessionId === s.id))) {
    const asked = (await loadAsides(db, older.id)).filter((a) => a.takenUpIn === session.id);
    const record = asideRecord(asThreads(asked), stepNumber);
    if (!record) continue;
    parts.push(`Questions the learner asked on ${lessonOf(older)}, after it closed:\n\n${record}`);
    open = true;
  }

  const last = sessions.filter((s) => s.closedAt !== null).at(-1);
  const shaky = last ? settlingSteps(last.state) : [];
  if (last && shaky.length > 0) {
    const [lesson] = await db.select().from(lessons).where(eq(lessons.sessionId, last.id));
    const threads = await db
      .select()
      .from(checkMessages)
      .where(and(eq(checkMessages.sessionId, last.id), inArray(checkMessages.stepId, shaky)))
      .orderBy(asc(checkMessages.createdAt), asc(checkMessages.id));
    const record = checkRecord({
      steps: last.state.lesson.steps,
      headings: (lesson?.outline?.steps ?? []).map((s) => s.heading),
      sources: lesson?.stepSources ?? {},
      threads,
      notes: lesson?.notes ?? {},
      alreadyHeld: {},
    });
    if (record) {
      parts.push(
        `Steps the learner continued past while still shaky, in ${lessonOf(last)}:\n\n${record}`,
      );
      open = true;
    }
  }
  return open ? { text: parts.join("\n\n"), labels } : null;
}

/**
 * Once a review a session took up is done or has failed, that session's review goes on if it was
 * waiting for it: its first message is written once no review it took up is under way.
 */
export async function afterTakenUpReview(
  db: Db,
  queue: JobQueue,
  assignmentId: string,
): Promise<void> {
  const [row] = await db
    .select({ sessionId: learningSessions.id, state: learningSessions.state })
    .from(reviews)
    .innerJoin(learningSessions, eq(learningSessions.id, reviews.takenUpIn))
    .where(eq(reviews.assignmentId, assignmentId));
  if (row?.state.phase !== "review") return;
  if (await reviewsUnderWay(db, row.sessionId)) return;
  if (await jobWaiting(db, "opening-review", row.sessionId)) return;
  await queue.enqueue("opening-review", { sessionId: row.sessionId });
}
