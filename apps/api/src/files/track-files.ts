import {
  and,
  answerFiles,
  asc,
  assignments,
  eq,
  inArray,
  trackFiles,
  tracks,
  type Db,
} from "@grounded/db";
import { v7 as uuidv7 } from "uuid";
import { log } from "../log.js";
import type { Attachment } from "./attachments.js";
import type { SourceUpload } from "./sources.js";
import type { FileStore } from "./store.js";

type TrackValues = Omit<typeof tracks.$inferInsert, "id">;

/**
 * Creates a track with its files (design §4.5): the bytes go to the store first, then the track and
 * its file rows in one transaction, so a row never names bytes that aren't there. If anything
 * fails, the bytes already stored are deleted again. The files are what the learner brought, or
 * the sources the track teaches (§4.6).
 */
export async function createTrack(
  db: Db,
  store: FileStore,
  values: TrackValues,
  attachments: readonly Attachment[] | readonly SourceUpload[],
  role: "brought" | "source" = "brought",
): Promise<typeof tracks.$inferSelect> {
  const trackId = uuidv7();
  const rows = attachments.map((a) => {
    const id = uuidv7();
    return {
      id,
      trackId,
      role,
      name: a.name,
      kind: a.kind,
      mediaType: a.mediaType,
      sizeBytes: a.bytes.length,
      pages: a.pages,
      text: "text" in a ? a.text : null,
      storageKey: `tracks/${trackId}/${id}`,
    };
  });
  const stored: string[] = [];
  try {
    await Promise.all(
      rows.map(async (row, i) => {
        await store.put(row.storageKey, attachments[i]?.bytes ?? new Uint8Array(), row.mediaType);
        stored.push(row.storageKey);
      }),
    );
    return await db.transaction(async (tx) => {
      const [track] = await tx
        .insert(tracks)
        .values({ ...values, id: trackId })
        .returning();
      if (!track) throw new Error("track insert returned nothing");
      if (rows.length) await tx.insert(trackFiles).values(rows);
      return track;
    });
  } catch (error) {
    const removed = await Promise.allSettled(stored.map((key) => store.delete(key)));
    const left = removed.filter((r) => r.status === "rejected").length;
    if (left)
      log.warn({ trackId, left }, "files of a track that wasn't created are left in the store");
    throw error;
  }
}

/**
 * Deletes a learner's track (design §4.5): the row, and by cascade everything in it (sessions and
 * their lessons, messages and events, terms, the fix-list, file rows, the imported lesson, homework
 * and its answers), then its
 * files' bytes, which the database can't reach. The rows go first, so no row ever names bytes that
 * are gone; bytes that can't be deleted are logged and left, reachable by nothing. False when the
 * learner has no such track.
 */
export async function deleteTrack(
  db: Db,
  store: FileStore,
  { userId, trackId }: { userId: string; trackId: string },
): Promise<boolean> {
  const keys = await db.transaction(async (tx) => {
    const files = await tx
      .select({ key: trackFiles.storageKey })
      .from(trackFiles)
      .innerJoin(tracks, eq(tracks.id, trackFiles.trackId))
      .where(and(eq(trackFiles.trackId, trackId), eq(tracks.userId, userId)));
    // And the pictures in the answers to its homework and exams.
    const pictures = await tx
      .select({ key: answerFiles.storageKey })
      .from(answerFiles)
      .innerJoin(assignments, eq(assignments.id, answerFiles.assignmentId))
      .where(and(eq(assignments.trackId, trackId), eq(assignments.userId, userId)));
    files.push(...pictures);
    const deleted = await tx
      .delete(tracks)
      .where(and(eq(tracks.id, trackId), eq(tracks.userId, userId)))
      .returning({ id: tracks.id });
    return deleted.length ? files.map((f) => f.key) : null;
  });
  if (!keys) return false;
  const removed = await Promise.allSettled(keys.map((key) => store.delete(key)));
  const left = removed.filter((r) => r.status === "rejected").length;
  if (left) log.warn({ trackId, left }, "files of a deleted track are left in the store");
  log.info({ files: keys.length }, "track deleted");
  return true;
}

/** The tracks' files, by track, in the order they were attached; what the browser may see of them. */
export async function filesOf(db: Db, trackIds: readonly string[]) {
  const rows = trackIds.length
    ? await db
        .select({
          id: trackFiles.id,
          trackId: trackFiles.trackId,
          name: trackFiles.name,
          kind: trackFiles.kind,
          role: trackFiles.role,
          sizeBytes: trackFiles.sizeBytes,
        })
        .from(trackFiles)
        .where(inArray(trackFiles.trackId, [...trackIds]))
        .orderBy(asc(trackFiles.createdAt), asc(trackFiles.id))
    : [];
  const byTrack = new Map<
    string,
    { id: string; name: string; kind: string; role: "brought" | "source"; sizeBytes: number }[]
  >();
  for (const { trackId, ...file } of rows)
    byTrack.set(trackId, [...(byTrack.get(trackId) ?? []), file]);
  return byTrack;
}

/**
 * One track's files the learner brought (not its sources, which are read into sections), with what
 * is needed to read them.
 */
export function trackFileRows(db: Db, trackId: string) {
  return db
    .select()
    .from(trackFiles)
    .where(and(eq(trackFiles.trackId, trackId), eq(trackFiles.role, "brought")))
    .orderBy(asc(trackFiles.createdAt), asc(trackFiles.id));
}
