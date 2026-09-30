import {
  and,
  asc,
  eq,
  inArray,
  learnerProfileNotes,
  learningSessions,
  sql,
  tracks,
  type Db,
} from "@grounded/db";
import type { Hono } from "hono";
import { z } from "zod";
import { TEACHING_NOTES_MAX } from "../engine/profile.js";

interface Env {
  Variables: { user: { id: string; email: string } };
}

/** A teaching note as the learner sees it, with the sessions it rests on. */
export interface TeachingNote {
  id: string;
  text: string;
  /** The learner wrote it, or edited it since the tutor last did. */
  byLearner: boolean;
  revisedAt: string;
  evidence: {
    what: string;
    /** Null once the session is gone (its track was deleted). */
    session: { id: string; trackTitle: string; number: number } | null;
  }[];
}

/** A note's text: a line or two of plain words. */
const noteText = z.object({ text: z.string().trim().min(1).max(500) });

/** The learner's teaching notes, oldest first. */
async function teachingNotes(db: Db, userId: string): Promise<TeachingNote[]> {
  const notes = await db
    .select()
    .from(learnerProfileNotes)
    .where(eq(learnerProfileNotes.userId, userId))
    .orderBy(asc(learnerProfileNotes.createdAt), asc(learnerProfileNotes.id));
  const ids = [...new Set(notes.flatMap((n) => n.evidence.map((e) => e.sessionId)))];
  const numbered = db
    .select({
      id: learningSessions.id,
      trackTitle: sql<string>`${tracks.title}`.as("track_title"),
      number:
        sql<number>`row_number() over (partition by ${learningSessions.trackId} order by ${learningSessions.createdAt}, ${learningSessions.id})::int`.as(
          "number",
        ),
    })
    .from(learningSessions)
    .innerJoin(tracks, eq(tracks.id, learningSessions.trackId))
    .where(eq(learningSessions.userId, userId))
    .as("numbered");
  const sessions = new Map(
    ids.length
      ? (await db.select().from(numbered).where(inArray(numbered.id, ids))).map((s) => [s.id, s])
      : [],
  );
  return notes.map((note) => ({
    id: note.id,
    text: note.text,
    byLearner: note.byLearner,
    revisedAt: note.revisedAt.toISOString(),
    evidence: note.evidence.map((e) => ({
      what: e.what,
      session: sessions.get(e.sessionId) ?? null,
    })),
  }));
}

/** The learner's teaching notes (design §8): they read, add, edit and remove them. */
export function registerProfileRoutes(app: Hono<Env>, deps: { db: Db }) {
  const { db } = deps;
  const owned = (userId: string, id: string) =>
    and(eq(learnerProfileNotes.id, id), eq(learnerProfileNotes.userId, userId));

  app.get("/api/profile/notes", async (c) => c.json(await teachingNotes(db, c.get("user").id)));

  app.post("/api/profile/notes", async (c) => {
    const parsed = noteText.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Write the note first." }, 400);
    const userId = c.get("user").id;
    const [{ count } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(learnerProfileNotes)
      .where(eq(learnerProfileNotes.userId, userId));
    if (count >= TEACHING_NOTES_MAX)
      return c.json({ error: `Keep it to ${String(TEACHING_NOTES_MAX)} notes.` }, 400);
    await db
      .insert(learnerProfileNotes)
      .values({ userId, text: parsed.data.text, byLearner: true });
    return c.json(await teachingNotes(db, userId), 201);
  });

  app.patch("/api/profile/notes/:id", async (c) => {
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success) return c.json({ error: "Not found." }, 404);
    const parsed = noteText.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Write the note first." }, 400);
    const userId = c.get("user").id;
    const updated = await db
      .update(learnerProfileNotes)
      .set({ text: parsed.data.text, byLearner: true, revisedAt: sql`now()` })
      .where(owned(userId, id))
      .returning({ id: learnerProfileNotes.id });
    if (updated.length === 0) return c.json({ error: "Not found." }, 404);
    return c.json(await teachingNotes(db, userId));
  });

  app.delete("/api/profile/notes/:id", async (c) => {
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success) return c.json({ error: "Not found." }, 404);
    const userId = c.get("user").id;
    await db.delete(learnerProfileNotes).where(owned(userId, id));
    return c.json(await teachingNotes(db, userId));
  });
}
