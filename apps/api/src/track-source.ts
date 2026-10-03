import type { SourceReading, SourceSectionView } from "@grounded/core";
import {
  and,
  asc,
  eq,
  isNotNull,
  learningSessions,
  sourceSections,
  trackFiles,
  tracks,
  type Db,
} from "@grounded/db";

export interface SourceCoverage {
  reading: SourceReading;
  sections: SourceSectionView[];
}

/**
 * A source track's coverage (design §4.6): each section of its sources, and what the track has done
 * with it. Taught where a session's lesson taught from it, known where the plan found the learner
 * already holds it, planned where an arc of the plan covers it. Null for a track that isn't the
 * learner's or has no source.
 */
export async function sourceCoverage(
  db: Db,
  { userId, trackId }: { userId: string; trackId: string },
): Promise<SourceCoverage | null> {
  const [track] = await db
    .select({ source: tracks.source, map: tracks.sourceMap })
    .from(tracks)
    .where(and(eq(tracks.id, trackId), eq(tracks.userId, userId)));
  if (!track?.source) return null;
  const sections = await db
    .select({
      n: sourceSections.n,
      title: sourceSections.title,
      pages: sourceSections.pages,
      source: trackFiles.name,
    })
    .from(sourceSections)
    .innerJoin(trackFiles, eq(trackFiles.id, sourceSections.fileId))
    .where(eq(sourceSections.trackId, trackId))
    .orderBy(asc(sourceSections.n));
  const sessions = await db
    .select({ sections: learningSessions.sourceSections, state: learningSessions.state })
    .from(learningSessions)
    .where(and(eq(learningSessions.trackId, trackId), isNotNull(learningSessions.sourceSections)));
  const taught = new Set(
    sessions.filter((s) => s.state.lesson.status === "ready").flatMap((s) => s.sections ?? []),
  );
  const known = new Set(track.map?.known ?? []);
  const planned = new Set(track.map?.arcs.flatMap((a) => a.sections) ?? []);
  return {
    reading: track.source,
    sections: sections.map((s) => ({
      ...s,
      status: taught.has(s.n)
        ? "taught"
        : known.has(s.n)
          ? "known"
          : planned.has(s.n)
            ? "planned"
            : "ahead",
    })),
  };
}
