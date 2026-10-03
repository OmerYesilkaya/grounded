import {
  ATTACHMENT_LIMITS,
  cleanTitle,
  needsNaming,
  refusal,
  SOURCE_LIMITS,
  standInTitle,
  type SourceReading,
} from "@grounded/core";
import { and, eq, importedLessons, sql, trackFiles, tracks, type Db } from "@grounded/db";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { SignedInUser } from "../auth.js";
import type { JobQueue } from "../engine/queue.js";
import { readAttachments, type UploadedFile } from "../files/attachments.js";
import { readSources } from "../files/sources.js";
import { FileNotFound, type FileStore } from "../files/store.js";
import { createTrack, deleteTrack } from "../files/track-files.js";
import { SURVEYING } from "../engine/source-tasks.js";
import { sourceCoverage } from "../track-source.js";
import { addLogContext } from "../log.js";
import { trackList } from "../track-list.js";
import { notFound, refuse } from "../refusals.js";

interface Env {
  Variables: { user: SignedInUser };
}

// No language: the tutor infers it from the learner's messages and records it (set-language).
const GOAL_MAX = 4000;
const trackInput = z.object({ goal: z.string().trim().min(1).max(GOAL_MAX) });
/** A track from a source: the learner's words are optional notes on why they are reading it. */
const sourceInput = z.object({ goal: z.string().trim().max(GOAL_MAX).default("") });
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

/** A source track's name until the survey reads the book's own title: the file's name. */
const sourceTitle = (name: string) =>
  cleanTitle(name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ")) ?? name;

/** Tracks: creating, listing and deleting them, and what hangs off them (design §4.5, §9.2). */
export function registerTrackRoutes(
  app: Hono<Env>,
  deps: { db: Db; queue: JobQueue; files: FileStore },
) {
  const { db, queue, files } = deps;

  // What a request may carry, with room for the form around the files: the files brought (design
  // §4.5), or a track's sources (`?from=source`, §4.6). Named in the address, so the limit applies
  // before anything is read.
  const limit = (bytes: number) =>
    bodyLimit({
      maxSize: bytes + 1024 * 1024,
      onError: (c) => c.json(refuse("files-too-large"), 413),
    });
  const broughtLimit = limit(ATTACHMENT_LIMITS.totalBytes);
  const sourceLimit = limit(SOURCE_LIMITS.totalBytes);

  app.post(
    "/api/tracks",
    (c, next) => (c.req.query("from") === "source" ? sourceLimit : broughtLimit)(c, next),
    async (c) => {
      const input = await trackInputOf(c);
      if (input && c.req.query("from") === "source") {
        const notes = sourceInput.safeParse({ goal: input.goal ?? "" });
        if (!notes.success) return c.json(GOAL_REQUIRED, 400);
        const read = await readSources(input.files);
        if (!read.ok) return c.json({ error: read.error }, 400);
        const first = read.sources[0]?.name ?? "";
        const track = await createTrack(
          db,
          files,
          {
            userId: c.get("user").id,
            goal: notes.data.goal,
            title: sourceTitle(first),
            source: SURVEYING,
          },
          read.sources,
          "source",
        );
        addLogContext({ trackId: track.id });
        await queue.enqueue("survey-source", { trackId: track.id });
        return c.json(
          { id: track.id, title: track.title, naming: false, language: track.language },
          201,
        );
      }
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
    },
  );

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

  /**
   * A source track's reading and coverage (design §4.6): where reading stands, and each section
   * with what the plan and the lessons have done with it.
   */
  app.get("/api/tracks/:id/source", async (c) => {
    const trackId = c.req.param("id");
    if (!z.uuid().safeParse(trackId).success) return c.json(notFound, 404);
    addLogContext({ trackId });
    const coverage = await sourceCoverage(db, { userId: c.get("user").id, trackId });
    if (!coverage) return c.json(notFound, 404);
    return c.json(coverage);
  });

  /**
   * The learner says to read the source, once they have seen what it will cost; or to try again
   * after reading stopped. Reading that stopped at a model call starts again where it stopped; a
   * source the model couldn't read is surveyed again (the learner may have changed their model).
   */
  app.post("/api/tracks/:id/source/read", async (c) => {
    const trackId = c.req.param("id");
    if (!z.uuid().safeParse(trackId).success) return c.json(notFound, 404);
    addLogContext({ trackId });
    const [track] = await db
      .select({ source: tracks.source })
      .from(tracks)
      .where(and(eq(tracks.id, trackId), eq(tracks.userId, c.get("user").id)));
    if (!track?.source) return c.json(notFound, 404);
    const next = nextReading(track.source);
    if (!next) return c.json(refuse("source-not-awaiting"), 409);
    // Only from the state just read, so two requests don't start two readings.
    const [moved] = await db
      .update(tracks)
      .set({ source: { ...track.source, status: next, failure: null } })
      .where(
        and(eq(tracks.id, trackId), sql`${tracks.source} ->> 'status' = ${track.source.status}`),
      )
      .returning({ id: tracks.id });
    if (!moved) return c.json(refuse("source-not-awaiting"), 409);
    await queue.enqueue(next === "reading" ? "read-source" : "survey-source", { trackId });
    return c.body(null, 202);
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

/** Where reading goes when the learner says to read: on from the estimate, or again after a stop. */
function nextReading(reading: SourceReading): "reading" | "surveying" | null {
  if (reading.status === "awaiting") return "reading";
  if (reading.status !== "failed") return null;
  if (reading.failure?.code === "source-reading-stopped") return "reading";
  if (reading.failure?.code === "source-needs-vision") return "surveying";
  return null;
}
