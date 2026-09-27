import { transition, type SessionEvent, type SessionState } from "@grounded/core";
import { eq, learningSessions, sql, type Db } from "@grounded/db";
import { publish } from "./events.js";
import type { JobQueue } from "./queue.js";

export class RejectedEvent extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RejectedEvent";
  }
}

export async function loadSession(db: Db, sessionId: string) {
  const [session] = await db
    .select()
    .from(learningSessions)
    .where(eq(learningSessions.id, sessionId));
  if (!session) throw new Error(`session ${sessionId} not found`);
  return session;
}

/**
 * Applies an event to a session through the state machine, holding the row lock so two jobs never
 * race on the same session, then publishes the new state. Throws RejectedEvent with the reason.
 */
export async function applyEvent(
  db: Db,
  sessionId: string,
  event: SessionEvent,
): Promise<SessionState> {
  const state = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(learningSessions)
      .where(eq(learningSessions.id, sessionId))
      .for("update");
    if (!row) throw new Error(`session ${sessionId} not found`);
    const result = transition(row.state, event);
    if (!result.ok) throw new RejectedEvent(result.reason);
    await tx
      .update(learningSessions)
      .set({
        state: result.state,
        ...(result.state.phase === "closed" ? { closedAt: sql`now()` } : {}),
      })
      .where(eq(learningSessions.id, sessionId));
    return result.state;
  });
  await publish(db, sessionId, "state", state);
  return state;
}

/** Once every check is resolved, the lesson is over: on to the homework. */
export async function completeIfDone(
  db: Db,
  queue: JobQueue,
  sessionId: string,
  state: SessionState,
): Promise<void> {
  const done =
    state.phase === "lesson" &&
    state.lesson.status === "ready" &&
    state.lesson.steps.length > 0 &&
    state.lesson.steps.every((s) => {
      const status = state.steps[s.id]?.status;
      return status === "passed" || status === "settling";
    });
  if (!done) return;
  await applyEvent(db, sessionId, { type: "checks-complete" });
  await queue.enqueue("homework", { sessionId });
}
