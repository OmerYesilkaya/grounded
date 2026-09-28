import type { SessionPhase } from "@grounded/core";
import {
  asc,
  eq,
  importedLessons,
  inArray,
  learningSessions,
  lessons,
  tracks,
  type Db,
} from "@grounded/db";
import { filesOf } from "./files/track-files.js";

/**
 * Something inside a track, listed under it in the track list (design §9.2). Every kind shares
 * these fields, so the list can order, fold and count items without knowing their kind; each kind
 * adds what its row says. Sessions are the only kind yet: homework and arc exams join as kinds of
 * their own (with a `due` of their own for the "tonight" tag).
 */
interface ItemBase {
  kind: string;
  id: string;
  /** Finished: folded under "N done" in the list. */
  done: boolean;
  /** When something last happened on it (ISO time). */
  activeAt: string;
}

export interface SessionItem extends ItemBase {
  kind: "session";
  /** The session's place in the track, from 1. */
  number: number;
  phase: SessionPhase;
  /** What the session's lesson teaches: the terms its outline introduces, in order; none before. */
  terms: string[];
}

export type TrackItem = SessionItem;

export interface TrackSummary {
  id: string;
  title: string;
  naming: boolean;
  language: string | null;
  /** The latest activity on the track or anything in it (ISO time); the list is ordered by it. */
  activeAt: string;
  items: TrackItem[];
  openSession: { id: string; phase: SessionPhase } | null;
  importedLesson: { title: string } | null;
  files: { id: string; name: string; kind: string; sizeBytes: number }[];
}

/** The learner's tracks with their items, the most recently active first (design §9.2). */
export async function trackList(db: Db, userId: string): Promise<TrackSummary[]> {
  const rows = await db.select().from(tracks).where(eq(tracks.userId, userId));
  const ids = rows.map((t) => t.id);
  const sessions = await db
    .select({
      id: learningSessions.id,
      trackId: learningSessions.trackId,
      state: learningSessions.state,
      closedAt: learningSessions.closedAt,
      updatedAt: learningSessions.updatedAt,
      outline: lessons.outline,
    })
    .from(learningSessions)
    .leftJoin(lessons, eq(lessons.sessionId, learningSessions.id))
    .where(eq(learningSessions.userId, userId))
    .orderBy(asc(learningSessions.createdAt), asc(learningSessions.id));
  const imported = ids.length
    ? await db
        .select({ trackId: importedLessons.trackId, title: importedLessons.title })
        .from(importedLessons)
        .where(inArray(importedLessons.trackId, ids))
    : [];
  const attached = await filesOf(db, ids);

  const list = rows.map((track): TrackSummary => {
    const items = sessions
      .filter((s) => s.trackId === track.id)
      .map((s, index): SessionItem => ({
        kind: "session",
        id: s.id,
        number: index + 1,
        phase: s.state.phase,
        terms: [...new Set(s.outline?.steps.flatMap((step) => step.introduces) ?? [])],
        done: s.closedAt !== null,
        activeAt: s.updatedAt.toISOString(),
      }));
    const open = items.find((item) => !item.done);
    const lesson = imported.find((l) => l.trackId === track.id);
    const activeAt = [track.updatedAt.toISOString(), ...items.map((i) => i.activeAt)].sort().at(-1);
    return {
      id: track.id,
      title: track.title,
      naming: track.titlePending,
      language: track.language,
      activeAt: activeAt ?? track.updatedAt.toISOString(),
      items,
      openSession: open ? { id: open.id, phase: open.phase } : null,
      importedLesson: lesson ? { title: lesson.title } : null,
      files: attached.get(track.id) ?? [],
    };
  });
  return list.sort((a, b) => b.activeAt.localeCompare(a.activeAt));
}
