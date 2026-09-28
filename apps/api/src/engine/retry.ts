import { awaitedJob, type AwaitedJob } from "@grounded/core";
import { desc, eq, sessionMessages, type Db } from "@grounded/db";
import { jobWaiting, type JobQueue } from "./queue.js";
import { loadSession } from "./session-store.js";
import { unlessWorkedOn } from "./work-locks.js";

/*
 * A job the learner can't set going again by writing (the probe's turn after their answer, a plan,
 * the homework, the recap) that failed, or died with its worker, leaves the session waiting on
 * nothing (design §4.2). Such a session is stalled, and "Try again" queues the same job again.
 */

/** The job a session waits on, if nothing is doing it: none is queued, and none is running. */
export async function stalledJob(db: Db, sessionId: string): Promise<AwaitedJob | null> {
  const waiting = await unlessWorkedOn(db, sessionId, () => waitedOn(db, sessionId));
  return waiting && !waiting.queued ? waiting.job : null;
}

/** The job the session waits on, and whether it is queued. No job may be running meanwhile. */
async function waitedOn(
  db: Db,
  sessionId: string,
): Promise<{ job: AwaitedJob; queued: boolean } | null> {
  const { state } = await loadSession(db, sessionId);
  const [last] = await db
    .select({ role: sessionMessages.role })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(desc(sessionMessages.createdAt), desc(sessionMessages.id))
    .limit(1);
  const job = awaitedJob(state, last?.role ?? null);
  return job ? { job, queued: await jobWaiting(db, job, sessionId) } : null;
}

export type RetryResult = { ok: true; job: AwaitedJob } | { ok: false; reason: string };

/**
 * Queues the job a stalled session waits on again. The job starts once this is done, so two clicks
 * queue it once.
 */
export async function retryStalled(
  db: Db,
  queue: JobQueue,
  sessionId: string,
): Promise<RetryResult> {
  const result = await unlessWorkedOn(db, sessionId, async (): Promise<RetryResult> => {
    const waiting = await waitedOn(db, sessionId);
    if (!waiting) return { ok: false, reason: "There is nothing to try again." };
    if (waiting.queued) return { ok: false, reason: "The tutor is already on it." };
    await queue.enqueue(waiting.job, { sessionId });
    return { ok: true, job: waiting.job };
  });
  return result ?? { ok: false, reason: "The tutor is still at work here." };
}
