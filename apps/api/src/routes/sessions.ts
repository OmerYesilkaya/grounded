import { initialSession, type SessionEvent } from "@grounded/core";
import {
  and,
  asc,
  checkMessages,
  desc,
  eq,
  isNull,
  learningSessions,
  lessons,
  sessionEvents,
  sessionMessages,
  tracks,
  type Db,
} from "@grounded/db";
import type { Hono } from "hono";
import { z } from "zod";
import { asidesSnapshot, hasAskedAside } from "../engine/asides.js";
import { messagesBeingWritten } from "../engine/chat.js";
import { publish, runningActivities } from "../engine/events.js";
import { writeLessonAgain } from "../engine/lesson-again.js";
import type { JobQueue } from "../engine/queue.js";
import { retryStalled, stalledJob } from "../engine/retry.js";
import { applyEvent, completeIfDone, loadSession, RejectedEvent } from "../engine/session-store.js";
import type { FileStore } from "../files/store.js";
import { addLogContext } from "../log.js";

interface Env {
  Variables: { user: { id: string; email: string; name: string } };
}

const messageInput = z.object({ text: z.string().trim().min(1).max(4000) });

/** Sessions (design §7): the session HTTP API. Jobs do the model work. */
export function registerSessionRoutes(
  app: Hono<Env>,
  deps: { db: Db; queue: JobQueue; files: FileStore },
) {
  const { db, queue } = deps;

  const ownSession = async (userId: string, sessionId: string) => {
    if (!z.uuid().safeParse(sessionId).success) return null;
    const [session] = await db
      .select()
      .from(learningSessions)
      .where(and(eq(learningSessions.id, sessionId), eq(learningSessions.userId, userId)));
    if (session) addLogContext({ sessionId: session.id, trackId: session.trackId });
    return session ?? null;
  };

  /** Applies an event and answers 409 with the state machine's reason if it is rejected. */
  const apply = async (sessionId: string, event: SessionEvent) => {
    try {
      return { ok: true as const, state: await applyEvent(db, sessionId, event) };
    } catch (error) {
      if (error instanceof RejectedEvent) return { ok: false as const, reason: error.message };
      throw error;
    }
  };

  app.post("/api/tracks/:id/sessions", async (c) => {
    const userId = c.get("user").id;
    const trackId = c.req.param("id");
    if (!z.uuid().safeParse(trackId).success) return c.json({ error: "Not found." }, 404);
    addLogContext({ trackId });
    const [track] = await db
      .select()
      .from(tracks)
      .where(and(eq(tracks.id, trackId), eq(tracks.userId, userId)));
    if (!track) return c.json({ error: "Not found." }, 404);
    const [open] = await db
      .select({ id: learningSessions.id })
      .from(learningSessions)
      .where(and(eq(learningSessions.trackId, trackId), isNull(learningSessions.closedAt)));
    if (open)
      return c.json({ error: "This track already has an open session.", sessionId: open.id }, 409);

    const [session] = await db
      .insert(learningSessions)
      .values({ trackId, userId, state: initialSession() })
      .returning();
    if (!session) throw new Error("session insert returned nothing");
    addLogContext({ sessionId: session.id });
    await publish(db, session.id, "state", session.state);
    await queue.enqueue("probe-turn", { sessionId: session.id });
    return c.json({ id: session.id }, 201);
  });

  /** Everything needed to draw the session; live changes then arrive on the stream. */
  app.get("/api/sessions/:id", async (c) => {
    const owned = await ownSession(c.get("user").id, c.req.param("id"));
    if (!owned) return c.json({ error: "Not found." }, 404);
    // Read the event cursor before the data, the state included: anything published while the rest
    // is read is then replayed by the stream (the browser ignores duplicates by id), not skipped.
    const [last] = await db
      .select({ id: sessionEvents.id })
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, owned.id))
      .orderBy(desc(sessionEvents.id))
      .limit(1);
    const cursor = last?.id ?? 0;
    const session = await loadSession(db, owned.id);

    const messages = await db
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, session.id))
      .orderBy(asc(sessionMessages.createdAt), asc(sessionMessages.id));
    const [lesson] = await db.select().from(lessons).where(eq(lessons.sessionId, session.id));
    const threads = await db
      .select()
      .from(checkMessages)
      .where(eq(checkMessages.sessionId, session.id))
      .orderBy(asc(checkMessages.createdAt), asc(checkMessages.id));
    const inFlight = await messagesBeingWritten(
      db,
      session.id,
      cursor,
      new Set(messages.map((m) => m.id)),
    );
    return c.json({
      id: session.id,
      trackId: session.trackId,
      state: session.state,
      messages: [
        ...messages.map((m) => ({
          id: m.id,
          role: m.role,
          kind: m.kind,
          text: m.role === "learner" ? m.text : null,
          blocks: m.blocks,
        })),
        ...inFlight,
      ],
      lesson: lesson
        ? {
            steps: lesson.steps,
            totalSteps: lesson.outline?.steps.length ?? lesson.steps.length,
            failedSteps: lesson.failedSteps,
            notes: lesson.notes,
          }
        : null,
      checks: threads.map((m) => ({
        id: m.id,
        stepId: m.stepId,
        role: m.role,
        text: m.text,
        blocks: m.blocks,
        verdict: m.verdict,
      })),
      // Questions asked in the margin (design §7.5), and whether the learner has ever asked one.
      asides: await asidesSnapshot(db, session.id, cursor),
      hasAskedAside: await hasAskedAside(db, session.userId),
      // What jobs are doing at the cursor; later changes arrive on the stream as activity events.
      activities: await runningActivities(db, session.id, cursor),
      // Waiting on a job nothing is doing (it failed, or died): the learner can try it again.
      stalled: (await stalledJob(db, session.id)) !== null,
      lastEventId: cursor,
    });
  });

  /** Queues the job a stalled session waits on again (retry.ts). */
  app.post("/api/sessions/:id/retry", async (c) => {
    const session = await ownSession(c.get("user").id, c.req.param("id"));
    if (!session) return c.json({ error: "Not found." }, 404);
    const retried = await retryStalled(db, queue, session.id);
    if (!retried.ok) return c.json({ error: retried.reason }, 409);
    return c.json({ job: retried.job }, 202);
  });

  app.post("/api/sessions/:id/messages", async (c) => {
    const session = await ownSession(c.get("user").id, c.req.param("id"));
    if (!session) return c.json({ error: "Not found." }, 404);
    const parsed = messageInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Write a message first." }, 400);

    const applied = await apply(session.id, { type: "learner-message" });
    if (!applied.ok) return c.json({ error: applied.reason }, 409);
    const [message] = await db
      .insert(sessionMessages)
      .values({ sessionId: session.id, role: "learner", text: parsed.data.text })
      .returning();
    if (!message) throw new Error("message insert returned nothing");
    await publish(db, session.id, "message", {
      id: message.id,
      role: "learner",
      kind: "message",
      text: message.text,
    });
    await queue.enqueue(applied.state.phase === "probe" ? "probe-turn" : "plan", {
      sessionId: session.id,
    });
    return c.json({ id: message.id }, 201);
  });

  app.post("/api/sessions/:id/skip-to-plan", async (c) => {
    const session = await ownSession(c.get("user").id, c.req.param("id"));
    if (!session) return c.json({ error: "Not found." }, 404);
    const applied = await apply(session.id, { type: "skip-to-plan" });
    if (!applied.ok) return c.json({ error: applied.reason }, 409);
    await queue.enqueue("plan", { sessionId: session.id });
    return c.json({ state: applied.state });
  });

  app.post("/api/sessions/:id/approve-plan", async (c) => {
    const session = await ownSession(c.get("user").id, c.req.param("id"));
    if (!session) return c.json({ error: "Not found." }, 404);
    const applied = await apply(session.id, { type: "plan-approved" });
    if (!applied.ok) return c.json({ error: applied.reason }, 409);
    await queue.enqueue("lesson", { sessionId: session.id });
    return c.json({ state: applied.state });
  });

  // A failed lesson, written again: the rest of it, or from the start (lesson-again.ts).
  for (const [path, from] of [
    ["write-rest", "rest"],
    ["start-over", "start"],
  ] as const) {
    app.post(`/api/sessions/:id/lesson/${path}`, async (c) => {
      const session = await ownSession(c.get("user").id, c.req.param("id"));
      if (!session) return c.json({ error: "Not found." }, 404);
      const again = await writeLessonAgain(db, queue, session.id, from);
      if (!again.ok) return c.json({ error: again.reason }, 409);
      return c.json({ state: again.state });
    });
  }

  const answerInput = z.union([
    z.object({ text: z.string().trim().min(1).max(2000) }),
    z.object({ dontKnow: z.literal(true) }),
  ]);

  app.post("/api/sessions/:id/steps/:stepId/answer", async (c) => {
    const session = await ownSession(c.get("user").id, c.req.param("id"));
    if (!session) return c.json({ error: "Not found." }, 404);
    const stepId = c.req.param("stepId");
    const parsed = answerInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Write an answer, or say you don't know." }, 400);

    const { state } = session;
    const step = state.steps[stepId];
    if (state.phase !== "lesson" || !step)
      return c.json({ error: "That step isn't in this lesson." }, 409);
    if (step.status === "paused")
      return c.json({ error: "This step is paused; resume it first." }, 409);
    if (state.currentStep !== stepId)
      return c.json({ error: "That step isn't the one being checked." }, 409);
    if (step.offerGate) return c.json({ error: "Choose to pause or continue first." }, 409);
    const [lesson] = await db.select().from(lessons).where(eq(lessons.sessionId, session.id));
    if (!lesson?.steps.some((s) => s.id === stepId))
      return c.json({ error: "This step is still being written." }, 409);
    const [last] = await db
      .select()
      .from(checkMessages)
      .where(and(eq(checkMessages.sessionId, session.id), eq(checkMessages.stepId, stepId)))
      .orderBy(desc(checkMessages.createdAt), desc(checkMessages.id))
      .limit(1);
    if (last?.role === "learner") return c.json({ error: "Your answer is being checked." }, 409);

    const text = "text" in parsed.data ? parsed.data.text : "I don't know";
    const [message] = await db
      .insert(checkMessages)
      .values({ sessionId: session.id, stepId, role: "learner", text })
      .returning();
    if (!message) throw new Error("check message insert returned nothing");
    await publish(db, session.id, "check-message", {
      id: message.id,
      stepId,
      role: "learner",
      text,
      verdict: null,
    });
    await queue.enqueue("check", { sessionId: session.id, stepId });
    return c.json({ id: message.id }, 202);
  });

  app.post("/api/sessions/:id/steps/:stepId/pause", async (c) => {
    const session = await ownSession(c.get("user").id, c.req.param("id"));
    if (!session) return c.json({ error: "Not found." }, 404);
    const applied = await apply(session.id, { type: "pause", stepId: c.req.param("stepId") });
    if (!applied.ok) return c.json({ error: applied.reason }, 409);
    return c.json({ state: applied.state });
  });

  app.post("/api/sessions/:id/steps/:stepId/continue", async (c) => {
    const session = await ownSession(c.get("user").id, c.req.param("id"));
    if (!session) return c.json({ error: "Not found." }, 404);
    const applied = await apply(session.id, { type: "continue", stepId: c.req.param("stepId") });
    if (!applied.ok) return c.json({ error: applied.reason }, 409);
    await completeIfDone(db, queue, session.id, applied.state);
    return c.json({ state: applied.state });
  });

  app.post("/api/sessions/:id/resume", async (c) => {
    const session = await ownSession(c.get("user").id, c.req.param("id"));
    if (!session) return c.json({ error: "Not found." }, 404);
    const applied = await apply(session.id, { type: "resume" });
    if (!applied.ok) return c.json({ error: applied.reason }, 409);
    await queue.enqueue("fresh-question", {
      sessionId: session.id,
      stepId: applied.state.currentStep,
    });
    return c.json({ state: applied.state });
  });
}
