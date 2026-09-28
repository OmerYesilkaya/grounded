import { asc, eq, inArray, trackFiles, tracks, type Db } from "@grounded/db";
import { v7 as uuidv7 } from "uuid";
import { log } from "../log.js";
import type { Attachment } from "./attachments.js";
import type { FileStore } from "./store.js";

type TrackValues = Omit<typeof tracks.$inferInsert, "id">;

/**
 * Creates a track with its files (design §4.5): the bytes go to the store first, then the track and
 * its file rows in one transaction, so a row never names bytes that aren't there. If anything
 * fails, the bytes already stored are deleted again.
 */
export async function createTrack(
  db: Db,
  store: FileStore,
  values: TrackValues,
  attachments: readonly Attachment[],
): Promise<typeof tracks.$inferSelect> {
  const trackId = uuidv7();
  const rows = attachments.map((a) => {
    const id = uuidv7();
    return {
      id,
      trackId,
      name: a.name,
      kind: a.kind,
      mediaType: a.mediaType,
      sizeBytes: a.bytes.length,
      pages: a.pages,
      text: a.text,
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

/** The tracks' files, by track, in the order they were attached; what the browser may see of them. */
export async function filesOf(db: Db, trackIds: readonly string[]) {
  const rows = trackIds.length
    ? await db
        .select({
          id: trackFiles.id,
          trackId: trackFiles.trackId,
          name: trackFiles.name,
          kind: trackFiles.kind,
          sizeBytes: trackFiles.sizeBytes,
        })
        .from(trackFiles)
        .where(inArray(trackFiles.trackId, [...trackIds]))
        .orderBy(asc(trackFiles.createdAt), asc(trackFiles.id))
    : [];
  const byTrack = new Map<
    string,
    { id: string; name: string; kind: string; sizeBytes: number }[]
  >();
  for (const { trackId, ...file } of rows)
    byTrack.set(trackId, [...(byTrack.get(trackId) ?? []), file]);
  return byTrack;
}

/** One track's files, with what is needed to read them. */
export function trackFileRows(db: Db, trackId: string) {
  return db
    .select()
    .from(trackFiles)
    .where(eq(trackFiles.trackId, trackId))
    .orderBy(asc(trackFiles.createdAt), asc(trackFiles.id));
}
