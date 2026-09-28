import {
  asc,
  checkMessages,
  desc,
  eq,
  isNull,
  learningSessions,
  lessons,
  sessionEvents,
  sessionMessages,
  sql,
  type Db,
} from "@grounded/db";
import { log, withLogContext } from "../log.js";
import { asideFailedText, loadAsides, recordAsideMessage, waitingFor } from "./asides.js";
import { messagesBeingWritten } from "./chat.js";
import { publish, runningActivities } from "./events.js";
import { applyEvent, loadSession } from "./session-store.js";
import { checkFailedText, recordCheckMessage } from "./session-tasks.js";
import { unlessWorkedOn } from "./work-locks.js";

/** What recovery cleaned up in one session. */
export interface RecoveredSession {
  sessionId: string;
  /** Tutor messages retracted. */
  messages: number;
  /** Activities ended. */
  activities: number;
  /** Steps whose check answer was told it didn't go through. */
  checks: string[];
  /** Questions in the margin told they didn't go through. */
  asides: number;
  /** Whether a lesson that stopped being written was marked failed. */
  lesson: boolean;
}

const INTERRUPTED = "The tutor was interrupted by a problem on our side. Try again.";
const LESSON_INTERRUPTED = "Writing the lesson was interrupted by a problem on our side.";

/**
 * Cleans up after jobs that died without finishing (a killed or crashed worker), in every open
 * session no live job is working on (work-locks.ts): a tutor message still being written is
 * retracted, a running activity is ended, a check answer still waiting for its verdict is told it
 * didn't go through, and a lesson that stopped being written is marked failed; the session then gets
 * an error event. Work still queued is left to its job: a queued check job grades the answer, a
 * queued lesson job writes the lesson. Safe while other workers run, and running it again changes
 * nothing.
 */
export async function recoverAbandonedWork(db: Db): Promise<RecoveredSession[]> {
  // A closed session runs no more jobs, and the recap that closes it is the last one.
  const open = await db
    .select({ id: learningSessions.id })
    .from(learningSessions)
    .where(isNull(learningSessions.closedAt));
  const recovered: RecoveredSession[] = [];
  for (const { id } of open) {
    const result = await withLogContext({ sessionId: id }, () =>
      unlessWorkedOn(db, id, () => recoverSession(db, id)),
    );
    if (!result) continue;
    // One line per session: what the job that died left half-done.
    const { sessionId, ...what } = result;
    log.warn({ sessionId, ...what }, "recovered a session a dead job left half-done");
    recovered.push(result);
  }
  log.info({ open: open.length, recovered: recovered.length }, "recovery done");
  return recovered;
}

/** Recovers one session no live job is working on; null when nothing was left half-done. */
async function recoverSession(db: Db, sessionId: string): Promise<RecoveredSession | null> {
  const [last] = await db
    .select({ id: sessionEvents.id })
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, sessionId))
    .orderBy(desc(sessionEvents.id))
    .limit(1);
  const cursor = last?.id ?? 0;

  const stored = await db
    .select({ id: sessionMessages.id })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId));
  const messages = await messagesBeingWritten(
    db,
    sessionId,
    cursor,
    new Set(stored.map((m) => m.id)),
  );
  for (const message of messages)
    await publish(db, sessionId, "message-retracted", { id: message.id });

  const activities = await runningActivities(db, sessionId, cursor);
  for (const activity of activities)
    await publish(db, sessionId, "activity", { ...activity, state: "done" });

  const checks: string[] = [];
  for (const stepId of await answersWaiting(db, sessionId)) {
    if (await queued(db, "check", sessionId, { stepId })) continue;
    await recordCheckMessage(db, sessionId, stepId, checkFailedText(), null);
    checks.push(stepId);
  }

  // A question in the margin still waiting for its answer is told in its card, like a check.
  let asides = 0;
  for (const aside of await loadAsides(db, sessionId)) {
    if (!waitingFor(aside) || (await queued(db, "aside", sessionId, { asideId: aside.id })))
      continue;
    await recordAsideMessage(db, sessionId, aside.id, { role: "tutor", text: asideFailedText() });
    asides++;
  }

  const lesson =
    (await lessonUnfinished(db, sessionId)) && !(await queued(db, "lesson", sessionId));
  if (lesson) await applyEvent(db, sessionId, { type: "lesson-failed" });

  // An aside's card says what happened itself; the session hears about the rest.
  const told = messages.length > 0 || activities.length > 0 || checks.length > 0 || lesson;
  if (!told && asides === 0) return null;
  if (told)
    await publish(db, sessionId, "error", { message: lesson ? LESSON_INTERRUPTED : INTERRUPTED });
  return {
    sessionId,
    messages: messages.length,
    activities: activities.length,
    checks,
    asides,
    lesson,
  };
}

/** Steps whose check thread ends with the learner's answer: it is waiting for a verdict. */
async function answersWaiting(db: Db, sessionId: string): Promise<string[]> {
  const thread = await db
    .select({ stepId: checkMessages.stepId, role: checkMessages.role })
    .from(checkMessages)
    .where(eq(checkMessages.sessionId, sessionId))
    .orderBy(asc(checkMessages.createdAt), asc(checkMessages.id));
  const lastRole = new Map<string, "learner" | "tutor">();
  for (const m of thread) lastRole.set(m.stepId, m.role);
  return [...lastRole].filter(([, role]) => role === "learner").map(([stepId]) => stepId);
}

/** A lesson being written (not yet outlined, or with steps neither written nor failed). */
async function lessonUnfinished(db: Db, sessionId: string): Promise<boolean> {
  const { state } = await loadSession(db, sessionId);
  if (state.phase !== "lesson") return false;
  if (state.lesson.status === "generating") return true;
  if (state.lesson.status !== "ready") return false;
  const [lesson] = await db.select().from(lessons).where(eq(lessons.sessionId, sessionId));
  if (!lesson?.outline) return false;
  return lesson.steps.length + lesson.failedSteps.length < lesson.outline.steps.length;
}

/**
 * Whether a job for the session (and the step or aside its payload names) is waiting to run. A job
 * whose worker died is not: it was attempted, and jobs are attempted once (queue.ts).
 */
async function queued(
  db: Db,
  task: string,
  sessionId: string,
  match: { stepId?: string; asideId?: string } = {},
): Promise<boolean> {
  const also = Object.entries(match).map(
    ([key, value]) => sql`and jobs.payload->>${key} = ${value}`,
  );
  const rows = await db.execute(sql`
    select 1
    from graphile_worker._private_jobs as jobs
    join graphile_worker._private_tasks as tasks on tasks.id = jobs.task_id
    where tasks.identifier = ${task}
      and jobs.is_available
      and jobs.payload->>'sessionId' = ${sessionId}
      ${sql.join(also, sql` `)}
    limit 1`);
  return rows.length > 0;
}
