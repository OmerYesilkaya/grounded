import { ATTACHMENT_LIMITS, needsNaming, standInTitle, refusal } from "@grounded/core";
import { and, eq, importedLessons, trackFiles, tracks, type Db } from "@grounded/db";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { SignedInUser } from "../auth.js";
import type { JobQueue } from "../engine/queue.js";
import { readAttachments, type UploadedFile } from "../files/attachments.js";
import { FileNotFound, type FileStore } from "../files/store.js";
import { createTrack, deleteTrack } from "../files/track-files.js";
import { addLogContext } from "../log.js";
import { trackList } from "../track-list.js";
import { notFound, refuse } from "../refusals.js";

interface Env {
  Variables: { user: SignedInUser };
}

// No language: the tutor infers it from the learner's messages and records it (set-language).
const GOAL_MAX = 4000;
const trackInput = z.object({ goal: z.string().trim().min(1).max(GOAL_MAX) });
const GOAL_REQUIRED = refusal({ code: "goal-required", max: GOAL_MAX });

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

/** Tracks: creating, listing and deleting them, and what hangs off them (design §4.5, §9.2). */
export function registerTrackRoutes(
  app: Hono<Env>,
  deps: { db: Db; queue: JobQueue; files: FileStore },
) {
  const { db, queue, files } = deps;

  // The files' limit (design §4.5), with room for the form around them.
  const uploadLimit = bodyLimit({
    maxSize: ATTACHMENT_LIMITS.totalBytes + 1024 * 1024,
    onError: (c) => c.json(refuse("files-too-large"), 413),
  });

  app.post("/api/tracks", uploadLimit, async (c) => {
    const input = await trackInputOf(c);
    const parsed = trackInput.safeParse({ goal: input?.goal });
    if (!input || !parsed.success) return c.json(GOAL_REQUIRED, 400);
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
      return c.json(notFound, 404);
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
    if (!file) return c.json(notFound, 404);
    let bytes: Uint8Array;
    try {
      bytes = await files.get(file.key);
    } catch (error) {
      if (error instanceof FileNotFound) return c.json(notFound, 404);
      throw error;
    }
    return c.body(bytes.slice(), 200, {
      "content-type": file.mediaType,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    });
  });

  /** The last lesson imported from the learner's earlier setup (design §10), for its owner only. */
  app.get("/api/tracks/:id/imported-lesson", async (c) => {
    const trackId = c.req.param("id");
    if (!z.uuid().safeParse(trackId).success) return c.json(notFound, 404);
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
    if (!lesson) return c.json(notFound, 404);
    return c.json(lesson);
  });

  /** The track list (design §9.2): every track with its items, the most recently active first. */
  app.get("/api/tracks", async (c) => c.json(await trackList(db, c.get("user").id)));

  /**
   * Deletes a track with everything in it and its files' bytes (design §4.5). A job still queued or
   * running on it ends quietly (engine/gone.ts).
   */
  app.delete("/api/tracks/:id", async (c) => {
    const trackId = c.req.param("id");
    if (!z.uuid().safeParse(trackId).success) return c.json(notFound, 404);
    addLogContext({ trackId });
    const deleted = await deleteTrack(db, files, { userId: c.get("user").id, trackId });
    if (!deleted) return c.json(notFound, 404);
    return c.body(null, 204);
  });
}
