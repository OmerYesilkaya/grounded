import { resolved, transition, type SessionEvent, type SessionState } from "@grounded/core";
import { eq, learningSessions, sql, type Db } from "@grounded/db";
import { log } from "../log.js";
import { appendEvent, lockSessionEvents } from "./events.js";
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
 * race on the same session, and publishes the new state in the same transaction, so states reach the
 * stream in the order they were applied. Throws RejectedEvent with the reason.
 */
export async function applyEvent(
  db: Db,
  sessionId: string,
  event: SessionEvent,
): Promise<SessionState> {
  return db.transaction(async (tx) => {
    // The event lock before the row lock, the order appending an event takes them in (events.ts).
    await lockSessionEvents(tx, sessionId);
    const [row] = await tx
      .select()
      .from(learningSessions)
      .where(eq(learningSessions.id, sessionId))
      .for("update");
    if (!row) throw new Error(`session ${sessionId} not found`);
    const result = transition(row.state, event);
    if (!result.ok) {
      log.warn(
        {
          sessionId,
          ...eventFields(event),
          state: describeState(row.state),
          reason: result.reason,
        },
        "session event rejected",
      );
      throw new RejectedEvent(result.reason);
    }
    await tx
      .update(learningSessions)
      .set({
        state: result.state,
        ...(result.state.phase === "closed" ? { closedAt: sql`now()` } : {}),
      })
      .where(eq(learningSessions.id, sessionId));
    await appendEvent(tx, sessionId, "state", result.state);
    log.info(
      {
        sessionId,
        ...eventFields(event),
        from: describeState(row.state),
        to: describeState(result.state),
      },
      "session state changed",
    );
    return result.state;
  });
}

/** An event for the log: its type, and the step and verdict it names (never content). */
function eventFields(event: SessionEvent) {
  return {
    event: event.type,
    ...("stepId" in event ? { stepId: event.stepId } : {}),
    ...("verdict" in event ? { verdict: event.verdict } : {}),
  };
}

/** A state in a few words: "plan (proposed)", "lesson (ready, at s2)". */
export function describeState(state: SessionState): string {
  switch (state.phase) {
    case "plan":
      return `plan (${state.plan})`;
    case "lesson":
      return `lesson (${[state.lesson.status, state.currentStep && `at ${state.currentStep}`].filter(Boolean).join(", ")})`;
    case "homework":
      return `homework (${state.homework ?? "writing"})`;
    default:
      return state.phase;
  }
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
    state.lesson.steps.every((s) => resolved(state.steps[s.id]));
  if (!done) return;
  await applyEvent(db, sessionId, { type: "checks-complete" });
  await queue.enqueue("homework", { sessionId });
}
