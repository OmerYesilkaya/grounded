import {
  ATTACHMENT_LIMITS,
  initialSession,
  needsNaming,
  standInTitle,
  type SessionEvent,
} from "@grounded/core";
import {
  and,
  asc,
  checkMessages,
  desc,
  eq,
  importedLessons,
  inArray,
  isNull,
  learningSessions,
  lessons,
  sessionEvents,
  sessionMessages,
  trackFiles,
  tracks,
  type Db,
} from "@grounded/db";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { messagesBeingWritten } from "../engine/chat.js";
import { publish, runningActivities } from "../engine/events.js";
import type { JobQueue } from "../engine/queue.js";
import { applyEvent, completeIfDone, loadSession, RejectedEvent } from "../engine/session-store.js";
import { readAttachments, type UploadedFile } from "../files/attachments.js";
import { FileNotFound, type FileStore } from "../files/store.js";
import { createTrack, filesOf } from "../files/track-files.js";
import { addLogContext } from "../log.js";

interface Env {
  Variables: { user: { id: string; email: string; name: string } };
}

// No language: the tutor infers it from the learner's messages and records it (set-language).
const trackInput = z.object({ goal: z.string().trim().min(1).max(4000) });
const GOAL_REQUIRED = "Say what you want to learn, in at most 4,000 characters.";
const messageInput = z.object({ text: z.string().trim().min(1).max(4000) });

/**
 * A new track's input: JSON `{ goal }`, or a form with `goal` and any number of `files` (the web
 * sends a form; the route's body limit bounds what is read). Null when it is neither.
 */
async function trackInputOf(
  c: Context<Env>,
): Promise<{ goal: unknown; files: UploadedFile[] } | null> {
  if (!(c.req.header("content-type") ?? "").startsWith("multipart/form-data")) {
    const body = (await c.req.json().catch(() => null)) as { goal?: unknown } | null;
    return body ? { goal: body.goal, files: [] } : null;
  }
  const form = await c.req.parseBody({ all: true }).catch(() => null);
  if (!form) return null;
  const files: UploadedFile[] = [];
  for (const entry of [form.files ?? []].flat())
    if (typeof entry !== "string")
      files.push({ name: entry.name, bytes: new Uint8Array(await entry.arrayBuffer()) });
  return { goal: form.goal, files };
}

/** Tracks and sessions (design §7): the session HTTP API. Jobs do the model work. */
export function registerSessionRoutes(
  app: Hono<Env>,
  deps: { db: Db; queue: JobQueue; files: FileStore },
) {
  const { db, queue, files } = deps;

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

  // The files' limit (design §4.5), with room for the form around them.
  const uploadLimit = bodyLimit({
    maxSize: ATTACHMENT_LIMITS.totalBytes + 1024 * 1024,
    onError: (c) => c.json({ error: "The files are too large together." }, 413),
  });

  app.post("/api/tracks", uploadLimit, async (c) => {
    const input = await trackInputOf(c);
    const parsed = trackInput.safeParse({ goal: input?.goal });
    if (!input || !parsed.success) return c.json({ error: GOAL_REQUIRED }, 400);
    const read = await readAttachments(input.files);
    if (!read.ok) return c.json({ error: read.error }, 400);
    const { goal } = parsed.data;
    // Words that already are a name are the name; the tutor names anything longer (design §9.5).
    const naming = needsNaming(goal);
    const track = await createTrack(
      db,
      files,
      { userId: c.get("user").id, goal, title: standInTitle(goal), titlePending: naming },
      read.attachments,
    );
    addLogContext({ trackId: track.id });
    if (naming) await queue.enqueue("name-track", { trackId: track.id });
    if (read.attachments.length) await queue.enqueue("track-brief", { trackId: track.id });
    return c.json(
      { id: track.id, title: track.title, naming: track.titlePending, language: track.language },
      201,
    );
  });

  /** A file the learner attached, for its owner only, as a download (never shown inline). */
  app.get("/api/tracks/:id/files/:fileId", async (c) => {
    const { id: trackId, fileId } = c.req.param();
    if (!z.uuid().safeParse(trackId).success || !z.uuid().safeParse(fileId).success)
      return c.json({ error: "Not found." }, 404);
    addLogContext({ trackId });
    const [file] = await db
      .select({
        name: trackFiles.name,
        mediaType: trackFiles.mediaType,
        key: trackFiles.storageKey,
      })
      .from(trackFiles)
      .innerJoin(tracks, eq(tracks.id, trackFiles.trackId))
      .where(
        and(
          eq(trackFiles.id, fileId),
          eq(trackFiles.trackId, trackId),
          eq(tracks.userId, c.get("user").id),
        ),
      );
    if (!file) return c.json({ error: "Not found." }, 404);
    let bytes: Uint8Array;
    try {
      bytes = await files.get(file.key);
    } catch (error) {
      if (error instanceof FileNotFound) return c.json({ error: "Not found." }, 404);
      throw error;
    }
    return c.body(bytes.slice(), 200, {
      "content-type": file.mediaType,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    });
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
    const imported = rows.length
      ? await db
          .select({ trackId: importedLessons.trackId, title: importedLessons.title })
          .from(importedLessons)
          .where(
            inArray(
              importedLessons.trackId,
              rows.map((t) => t.id),
            ),
          )
      : [];
    const attached = await filesOf(
      db,
      rows.map((t) => t.id),
    );
    return c.json(
      rows.map((t) => {
        const session = open.find((s) => s.trackId === t.id);
        const lesson = imported.find((l) => l.trackId === t.id);
        return {
          id: t.id,
          title: t.title,
          naming: t.titlePending,
          language: t.language,
          openSession: session ? { id: session.id, phase: session.state.phase } : null,
          importedLesson: lesson ? { title: lesson.title } : null,
          files: attached.get(t.id) ?? [],
        };
      }),
    );
  });

  /** The last lesson imported from the learner's earlier setup (design §10), for its owner only. */
  app.get("/api/tracks/:id/imported-lesson", async (c) => {
    const trackId = c.req.param("id");
    if (!z.uuid().safeParse(trackId).success) return c.json({ error: "Not found." }, 404);
    addLogContext({ trackId });
    const [lesson] = await db
      .select({
        title: importedLessons.title,
        source: importedLessons.source,
        html: importedLessons.html,
      })
      .from(importedLessons)
      .innerJoin(tracks, eq(tracks.id, importedLessons.trackId))
      .where(and(eq(importedLessons.trackId, trackId), eq(tracks.userId, c.get("user").id)));
    if (!lesson) return c.json({ error: "Not found." }, 404);
    return c.json(lesson);
  });

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
      // What jobs are doing at the cursor; later changes arrive on the stream as activity events.
      activities: await runningActivities(db, session.id, cursor),
      lastEventId: cursor,
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
