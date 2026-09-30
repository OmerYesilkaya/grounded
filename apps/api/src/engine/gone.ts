import { eq, learningSessions, tracks, type Db } from "@grounded/db";
import type { TaskList } from "graphile-worker";
import { log } from "../log.js";

/**
 * Whether the session or track a job works on still exists. Deleting a track (design §4.5) takes
 * its sessions with it, while a job may still be queued or running on one.
 */
async function stillThere(db: Db, payload: unknown): Promise<boolean> {
  if (typeof payload !== "object" || payload === null) return true;
  const { sessionId, trackId } = payload as { sessionId?: unknown; trackId?: unknown };
  if (typeof sessionId === "string") {
    const [row] = await db
      .select({ id: learningSessions.id })
      .from(learningSessions)
      .where(eq(learningSessions.id, sessionId));
    return row !== undefined;
  }
  if (typeof trackId === "string") {
    const [row] = await db.select({ id: tracks.id }).from(tracks).where(eq(tracks.id, trackId));
    return row !== undefined;
  }
  return true;
}

/**
 * Jobs on a deleted track end quietly. One still queued doesn't start; one running when the track
 * goes stops at its next write (a row it adds has nothing left to belong to) and ends as done, not
 * failed: nobody is left to tell. Its model call in flight finishes and is recorded in
 * `usage_events`, which belongs to the learner, not the track; its content is not stored
 * (`model_calls` goes with the track).
 */
export function endingWhenGone(tasks: TaskList, db: Db): TaskList {
  const wrapped: TaskList = {};
  for (const [name, task] of Object.entries(tasks)) {
    if (!task) continue;
    wrapped[name] = async (payload, helpers) => {
      if (!(await stillThere(db, payload))) {
        log.info("the job's track was deleted before it started; nothing to do");
        return;
      }
      try {
        await task(payload, helpers);
      } catch (error) {
        if (await stillThere(db, payload).catch(() => true)) throw error;
        log.info("the job's track was deleted while it ran; it stopped there");
      }
    };
  }
  return wrapped;
}
