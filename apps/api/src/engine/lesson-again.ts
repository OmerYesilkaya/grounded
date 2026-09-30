import { bare, type RefusalNotice, type SessionState } from "@grounded/core";
import { and, checkMessages, eq, inArray, lessons, type Db } from "@grounded/db";
import { publish } from "./events.js";
import type { JobQueue } from "./queue.js";
import { applyEvent, completeIfDone, loadSession } from "./session-store.js";
import { unlessWorkedOn } from "./work-locks.js";

export type LessonAgainResult =
  { ok: true; state: SessionState } | { ok: false; reason: RefusalNotice };

const ONLY_FAILED = bare("only-failed-lesson");

/**
 * Writes a failed lesson again (design §4.2): `rest` keeps its outline and the steps written before
 * the first one missing, and writes the rest; `start` writes it from a new outline. What the dropped
 * steps had (their text, check threads, notes) goes with them, and the `lesson-again` event tells
 * the browser what is kept. Done only while no job works on the session, and the lesson job it
 * queues starts once it is done; every write before the state change can be made again, so a
 * request that fails part-way is simply sent again.
 */
export async function writeLessonAgain(
  db: Db,
  queue: JobQueue,
  sessionId: string,
  from: "rest" | "start",
): Promise<LessonAgainResult> {
  const result = await unlessWorkedOn(db, sessionId, async (): Promise<LessonAgainResult> => {
    const { state } = await loadSession(db, sessionId);
    if (state.phase !== "lesson" || state.lesson.status !== "failed")
      return { ok: false, reason: ONLY_FAILED };
    const [lesson] = await db.select().from(lessons).where(eq(lessons.sessionId, sessionId));
    return from === "rest"
      ? writeRest(db, queue, sessionId, lesson)
      : startOver(db, queue, sessionId);
  });
  return result ?? { ok: false, reason: bare("tutor-busy") };
}

async function writeRest(
  db: Db,
  queue: JobQueue,
  sessionId: string,
  lesson: typeof lessons.$inferSelect | undefined,
): Promise<LessonAgainResult> {
  if (!lesson?.outline) return { ok: false, reason: bare("no-outline") };
  const ids = lesson.outline.steps.map((_, i) => `s${String(i + 1)}`);
  const written = new Set(lesson.steps.map((s) => s.id));
  const missing = ids.findIndex((id) => !written.has(id));
  const keep = missing === -1 ? ids : ids.slice(0, missing);
  const dropped = ids.slice(keep.length);
  const kept = <T>(byStep: Record<string, T>) =>
    Object.fromEntries(Object.entries(byStep).filter(([id]) => keep.includes(id)));
  await db
    .update(lessons)
    .set({
      steps: lesson.steps.filter((s) => keep.includes(s.id)),
      stepSources: kept(lesson.stepSources),
      failedSteps: [],
      notes: kept(lesson.notes),
      alreadyHeld: kept(lesson.alreadyHeld),
    })
    .where(eq(lessons.sessionId, sessionId));
  if (dropped.length > 0)
    await db
      .delete(checkMessages)
      .where(and(eq(checkMessages.sessionId, sessionId), inArray(checkMessages.stepId, dropped)));
  await publish(db, sessionId, "lesson-again", { keep, totalSteps: ids.length });
  const state = await applyEvent(db, sessionId, {
    type: "lesson-resumed",
    from: dropped[0] ?? null,
  });
  // Every step is written (the job failed after the last one): the lesson simply goes on.
  if (dropped.length === 0) await completeIfDone(db, queue, sessionId, state);
  else await queue.enqueue("lesson", { sessionId });
  return { ok: true, state };
}

async function startOver(db: Db, queue: JobQueue, sessionId: string): Promise<LessonAgainResult> {
  await db
    .update(lessons)
    .set({
      outline: null,
      steps: [],
      stepSources: {},
      failedSteps: [],
      notes: {},
      alreadyHeld: {},
    })
    .where(eq(lessons.sessionId, sessionId));
  await db.delete(checkMessages).where(eq(checkMessages.sessionId, sessionId));
  await publish(db, sessionId, "lesson-again", { keep: [], totalSteps: 0 });
  const state = await applyEvent(db, sessionId, { type: "lesson-restarted" });
  await queue.enqueue("lesson", { sessionId });
  return { ok: true, state };
}
