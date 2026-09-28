import { ASIDE_LIMITS, asideAnchorSchema, stepOfBlock } from "@grounded/core";
import { and, asides, eq, isNull, learningSessions, lessons, type Db } from "@grounded/db";
import type { Hono } from "hono";
import { z } from "zod";
import {
  ASIDE_SOURCE,
  createAside,
  loadAsides,
  openSteps,
  recordAsideMessage,
  waitingFor,
} from "../engine/asides.js";
import { publish } from "../engine/events.js";
import type { JobQueue } from "../engine/queue.js";
import { applyActions } from "../engine/track-state.js";
import { addLogContext } from "../log.js";

interface Env {
  Variables: { user: { id: string; email: string; name: string } };
}

const question = z.string().trim().min(1).max(ASIDE_LIMITS.question);
const askInput = z.object({ anchor: asideAnchorSchema, text: question });
const followUpInput = z.object({ text: question });
const QUESTION_REQUIRED = "Write your question first.";

/**
 * Asides (design §7.5): ask about a passage of the lesson, follow up in the card, and save a
 * tangent the tutor offered for a future session. The aside job answers.
 */
export function registerAsideRoutes(app: Hono<Env>, deps: { db: Db; queue: JobQueue }) {
  const { db, queue } = deps;

  /** The learner's open session: asides feed its checks and its close, so a closed one takes none. */
  const openSession = async (userId: string, sessionId: string) => {
    if (!z.uuid().safeParse(sessionId).success)
      return { error: "Not found.", status: 404 as const };
    const [session] = await db
      .select()
      .from(learningSessions)
      .where(and(eq(learningSessions.id, sessionId), eq(learningSessions.userId, userId)));
    if (!session) return { error: "Not found.", status: 404 as const };
    addLogContext({ sessionId: session.id, trackId: session.trackId });
    if (session.closedAt !== null)
      return { error: "This session is closed.", status: 409 as const };
    return { session };
  };

  const ownAside = async (sessionId: string, asideId: string) => {
    if (!z.uuid().safeParse(asideId).success) return null;
    const aside = (await loadAsides(db, sessionId)).find((a) => a.id === asideId);
    if (aside) addLogContext({ asideId });
    return aside ?? null;
  };

  app.post("/api/sessions/:id/asides", async (c) => {
    const found = await openSession(c.get("user").id, c.req.param("id"));
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const { session } = found;
    const parsed = askInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: QUESTION_REQUIRED }, 400);
    const { anchor, text } = parsed.data;
    const stepId = stepOfBlock(anchor.blockId);
    const [lesson] = await db
      .select({ steps: lessons.steps })
      .from(lessons)
      .where(eq(lessons.sessionId, session.id));
    if (!lesson?.steps.some((s) => s.id === stepId) || !openSteps(session.state).has(stepId))
      return c.json({ error: "That passage isn't in the lesson you can read." }, 409);

    const { aside } = await createAside(db, session.id, { stepId, anchor, question: text });
    addLogContext({ asideId: aside.id });
    await queue.enqueue("aside", { sessionId: session.id, asideId: aside.id });
    return c.json({ id: aside.id }, 201);
  });

  app.post("/api/sessions/:id/asides/:asideId/messages", async (c) => {
    const found = await openSession(c.get("user").id, c.req.param("id"));
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const aside = await ownAside(found.session.id, c.req.param("asideId"));
    if (!aside) return c.json({ error: "Not found." }, 404);
    const parsed = followUpInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: QUESTION_REQUIRED }, 400);
    if (waitingFor(aside)) return c.json({ error: "Your last question is being answered." }, 409);

    const message = await recordAsideMessage(db, found.session.id, aside.id, {
      role: "learner",
      text: parsed.data.text,
    });
    await queue.enqueue("aside", { sessionId: found.session.id, asideId: aside.id });
    return c.json({ id: message.id }, 201);
  });

  // The tangent goes into the plan's notes, which the close folds into the plan and into "where
  // you left off", so a later session's plan hears it (design §7.5).
  app.post("/api/sessions/:id/asides/:asideId/save", async (c) => {
    const found = await openSession(c.get("user").id, c.req.param("id"));
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const { session } = found;
    const aside = await ownAside(session.id, c.req.param("asideId"));
    if (!aside) return c.json({ error: "Not found." }, 404);
    if (!aside.tangent) return c.json({ error: "There is nothing to save here." }, 409);
    if (aside.savedAt) return c.json({ saved: true });

    // Only the first save writes the note, however many arrive at once.
    const [saved] = await db
      .update(asides)
      .set({ savedAt: new Date() })
      .where(and(eq(asides.id, aside.id), isNull(asides.savedAt)))
      .returning({ id: asides.id });
    if (!saved) return c.json({ saved: true });
    const asked = aside.messages.find((m) => m.role === "learner")?.text ?? "";
    await applyActions(
      db,
      session.trackId,
      [
        {
          type: "add-plan-notes",
          notes: `- A tangent the learner saved for a future session, from a question in the margin of a lesson: ${aside.tangent}. They asked: "${asked}"`,
        },
      ],
      { source: ASIDE_SOURCE },
    );
    await publish(db, session.id, "aside-saved", { asideId: aside.id });
    return c.json({ saved: true });
  });
}
