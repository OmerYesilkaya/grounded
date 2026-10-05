import type { NextReading, SourceChapterView, SourceReading } from "@grounded/core";
import {
  and,
  asc,
  eq,
  inArray,
  learningSessions,
  sourceChapters,
  trackFiles,
  tracks,
  type Db,
} from "@grounded/db";

export interface SourceProgress {
  reading: SourceReading;
  chapters: SourceChapterView[];
  /** The chapter to read next; null before the source is read and once every chapter is read. */
  next: NextReading | null;
}

/**
 * A source track's reading progress (design §4.6): each chapter of its sources, and where the
 * learner stands with it. Assigned where it is the one to read next, read where they have finished
 * it and no session has probed it yet, taught where a session's lesson taught what they missed in
 * it, held where a session probed it and found nothing to teach, skipped where it is the book's
 * apparatus. Null for a track that isn't the learner's or has no source.
 */
export async function sourceProgress(
  db: Db,
  { userId, trackId }: { userId: string; trackId: string },
): Promise<SourceProgress | null> {
  const [track] = await db
    .select({ source: tracks.source })
    .from(tracks)
    .where(and(eq(tracks.id, trackId), eq(tracks.userId, userId)));
  if (!track?.source) return null;
  const chapters = await db
    .select({
      n: sourceChapters.n,
      title: sourceChapters.title,
      part: sourceChapters.part,
      pages: sourceChapters.pages,
      kind: sourceChapters.kind,
      source: trackFiles.name,
    })
    .from(sourceChapters)
    .innerJoin(trackFiles, eq(trackFiles.id, sourceChapters.fileId))
    .where(eq(sourceChapters.trackId, trackId))
    .orderBy(asc(sourceChapters.n));
  const sessions = await db
    .select({
      chapters: learningSessions.sourceChapters,
      state: learningSessions.state,
      lessonNeeded: learningSessions.lessonNeeded,
    })
    .from(learningSessions)
    .where(eq(learningSessions.trackId, trackId));
  // A session's chapters are probed once its plan is in; taught once its lesson is, held when its
  // plan found nothing to teach.
  const taught = new Set<number>();
  const held = new Set<number>();
  for (const s of sessions) {
    if (s.state.plan === "none") continue;
    for (const n of s.chapters) {
      if (s.lessonNeeded) {
        if (
          s.state.lesson.status === "ready" ||
          s.state.phase === "homework" ||
          s.state.phase === "close" ||
          s.state.phase === "closed"
        )
          taught.add(n);
      } else held.add(n);
    }
  }
  const readThrough = track.source.readThrough ?? 0;
  const assigned = track.source.assigned ?? null;
  const first = sessions.length === 0;
  return {
    reading: track.source,
    chapters: chapters.map(({ kind, ...c }) => ({
      ...c,
      status:
        kind === "apparatus"
          ? "skipped"
          : taught.has(c.n)
            ? "taught"
            : held.has(c.n)
              ? "held"
              : c.n <= readThrough
                ? "read"
                : c.n === assigned
                  ? "assigned"
                  : "ahead",
    })),
    next: await nextReading(db, { trackId, source: track.source }, first),
  };
}

/** The chapter a learner is asked to read next, as the track shows it; null when there is none. */
export async function nextReading(
  db: Db,
  track: { trackId: string; source: SourceReading | null },
  first: boolean,
): Promise<NextReading | null> {
  const assigned = track.source?.assigned;
  if (track.source?.status !== "ready" || assigned === null || assigned === undefined) return null;
  const [found] = await nextReadings(
    db,
    [{ ...track, assigned }],
    first ? new Set([track.trackId]) : new Set(),
  );
  return found?.next ?? null;
}

/** The next readings of several tracks at once (the track list). */
export async function nextReadings(
  db: Db,
  assigned: readonly { trackId: string; assigned: number }[],
  firsts: ReadonlySet<string>,
): Promise<{ trackId: string; next: NextReading }[]> {
  if (assigned.length === 0) return [];
  const rows = await db
    .select({
      trackId: sourceChapters.trackId,
      n: sourceChapters.n,
      title: sourceChapters.title,
      pages: sourceChapters.pages,
      characters: sourceChapters.characters,
      assumes: sourceChapters.assumes,
      source: trackFiles.name,
    })
    .from(sourceChapters)
    .innerJoin(trackFiles, eq(trackFiles.id, sourceChapters.fileId))
    .where(
      inArray(
        sourceChapters.trackId,
        assigned.map((a) => a.trackId),
      ),
    );
  return assigned.flatMap(({ trackId, assigned: n }) => {
    const row = rows.find((r) => r.trackId === trackId && r.n === n);
    return row
      ? [
          {
            trackId,
            next: {
              n: row.n,
              source: row.source,
              title: row.title,
              pages: row.pages,
              characters: row.characters,
              assumes: row.assumes ?? "",
              first: firsts.has(trackId),
            },
          },
        ]
      : [];
  });
}
