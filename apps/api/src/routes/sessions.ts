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
import { publish } from "../engine/events.js";
import type { JobQueue } from "../engine/queue.js";
import { applyEvent, RejectedEvent } from "../engine/session-store.js";

interface Env {
  Variables: { user: { id: string; email: string; name: string } };
}

const trackInput = z.object({
  title: z.string().trim().min(1).max(120),
  language: z.string().trim().min(1).max(40).default("English"),
});
const messageInput = z.object({ text: z.string().trim().min(1).max(4000) });

/** Tracks and sessions (design §7): the session HTTP API. Jobs do the model work. */
export function registerSessionRoutes(app: Hono<Env>, deps: { db: Db; queue: JobQueue }) {
  const { db, queue } = deps;

  const ownSession = async (userId: string, sessionId: string) => {
    if (!z.uuid().safeParse(sessionId).success) return null;
    const [session] = await db
      .select()
      .from(learningSessions)
      .where(and(eq(learningSessions.id, sessionId), eq(learningSessions.userId, userId)));
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

  app.post("/api/tracks", async (c) => {
    const parsed = trackInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Give the track a name." }, 400);
    const [track] = await db
      .insert(tracks)
      .values({ userId: c.get("user").id, ...parsed.data })
      .returning();
    if (!track) throw new Error("track insert returned nothing");
    return c.json({ id: track.id, title: track.title, language: track.language }, 201);
  });

  app.get("/api/tracks", async (c) => {
    const userId = c.get("user").id;
    const rows = await db
      .select()
      .from(tracks)
      .where(eq(tracks.userId, userId))
      .orderBy(desc(tracks.updatedAt));
    const open = await db
      .select()
      .from(learningSessions)
      .where(and(eq(learningSessions.userId, userId), isNull(learningSessions.closedAt)));
    return c.json(
      rows.map((t) => {
        const session = open.find((s) => s.trackId === t.id);
        return {
          id: t.id,
          title: t.title,
          language: t.language,
          openSession: session ? { id: session.id, phase: session.state.phase } : null,
        };
      }),
    );
  });

  app.post("/api/tracks/:id/sessions", async (c) => {
    const userId = c.get("user").id;
    const trackId = c.req.param("id");
    if (!z.uuid().safeParse(trackId).success) return c.json({ error: "Not found." }, 404);
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
    await publish(db, session.id, "state", session.state);
    await queue.enqueue("probe-turn", { sessionId: session.id });
    return c.json({ id: session.id }, 201);
  });

  /** Everything needed to draw the session; live changes then arrive on the stream. */
  app.get("/api/sessions/:id", async (c) => {
    const session = await ownSession(c.get("user").id, c.req.param("id"));
    if (!session) return c.json({ error: "Not found." }, 404);
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
    const [last] = await db
      .select({ id: sessionEvents.id })
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, session.id))
      .orderBy(desc(sessionEvents.id))
      .limit(1);

    return c.json({
      id: session.id,
      trackId: session.trackId,
      state: session.state,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        kind: m.kind,
        text: m.role === "learner" ? m.text : null,
        blocks: m.blocks,
      })),
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
      lastEventId: last?.id ?? 0,
    });
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
}
