import {
  and,
  desc,
  eq,
  learningSessions,
  lessons,
  sessionMessages,
  sql,
  type Db,
} from "@grounded/db";
import type { Hono } from "hono";
import { z } from "zod";
import { addLogContext } from "../log.js";
import { loadTrackTerms, termMap, type TermMap } from "../term-map.js";
import { trackProgress } from "../track-progress.js";

interface Env {
  Variables: { user: { id: string; email: string; name: string } };
}

/** A session's pictures of what rests on what (design §3.2, §9.1). */
export interface SessionPictures {
  /** The latest plan's, once its record is written: its terms and what they rest on. */
  plan: { messageId: string; map: TermMap } | null;
  /**
   * "What you just built": the lesson's terms and what they rest on, once its checks are done
   * (before then its terms are still to be discovered).
   */
  built: TermMap | null;
}

/** The phases after the lesson's last check. */
const AFTER_LESSON = new Set(["homework", "close", "closed"]);

/** A track's page (design §8), and the pictures drawn from the map (§3.2, §9.1). */
export function registerProgressRoutes(app: Hono<Env>, deps: { db: Db }) {
  const { db } = deps;

  app.get("/api/tracks/:id/progress", async (c) => {
    const trackId = c.req.param("id");
    if (!z.uuid().safeParse(trackId).success) return c.json({ error: "Not found." }, 404);
    addLogContext({ trackId });
    const progress = await trackProgress(db, c.get("user").id, trackId);
    if (!progress) return c.json({ error: "Not found." }, 404);
    return c.json(progress);
  });

  app.get("/api/sessions/:id/pictures", async (c) => {
    const sessionId = c.req.param("id");
    if (!z.uuid().safeParse(sessionId).success) return c.json({ error: "Not found." }, 404);
    const [session] = await db
      .select()
      .from(learningSessions)
      .where(
        and(eq(learningSessions.id, sessionId), eq(learningSessions.userId, c.get("user").id)),
      );
    if (!session) return c.json({ error: "Not found." }, 404);
    addLogContext({ sessionId, trackId: session.trackId });
    const track = await loadTrackTerms(db, session.trackId);

    const [plan] = await db
      .select({ id: sessionMessages.id, terms: sessionMessages.planTerms })
      .from(sessionMessages)
      .where(
        and(
          eq(sessionMessages.sessionId, sessionId),
          eq(sessionMessages.kind, "plan"),
          sql`${sessionMessages.planTerms} is not null`,
        ),
      )
      .orderBy(desc(sessionMessages.createdAt), desc(sessionMessages.id))
      .limit(1);
    const [lesson] = AFTER_LESSON.has(session.state.phase)
      ? await db
          .select({ outline: lessons.outline })
          .from(lessons)
          .where(eq(lessons.sessionId, sessionId))
      : [];
    const introduced = lesson?.outline?.steps.flatMap((s) => s.introduces) ?? [];

    const pictures: SessionPictures = {
      plan: plan?.terms ? { messageId: plan.id, map: termMap(track, plan.terms) } : null,
      built: introduced.length ? termMap(track, introduced) : null,
    };
    return c.json(pictures);
  });
}
