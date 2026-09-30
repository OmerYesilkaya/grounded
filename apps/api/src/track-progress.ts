import {
  and,
  asc,
  desc,
  eq,
  fixListItems,
  inArray,
  learningSessions,
  termEvents,
  tracks,
  type Db,
} from "@grounded/db";
import type { ProbeVerdict } from "@grounded/core";
import { whereYouStarted } from "./engine/probe-verdict.js";
import { loadTrackTerms, standingOf, termMap, type Standing, type TermMap } from "./term-map.js";

/*
 * A track's page (design §8): what the learner owns and what is still settling, in plain words,
 * what to revisit, and the map of each arc. The sessions done and the open work are the track
 * list's items (track-list.ts), where homework and arc exams join as kinds of their own.
 */

/** An idea the learner owns or is still settling, with what shows where it stands. */
export interface Idea {
  term: string;
  standing: Exclude<Standing, "coming">;
  /** They held it before this track taught it (the probe found it), rather than learning it here. */
  brought: boolean;
  /** The track a borrowed idea is held in. */
  from?: string;
  /** What it rests on, by name. */
  restsOn: string[];
  /** Its latest change: when, the words that showed it, and the session it happened in, if any. */
  since: string;
  evidence: string;
  session: { id: string; number: number } | null;
}

export interface TrackProgress {
  owned: Idea[];
  settling: Idea[];
  /** Ideas still to come in the plan: counted, not named (they haven't been taught). */
  coming: number;
  /** What the tutor will come back to: the open fix-list items. */
  revisit: string[];
  /**
   * "Where you started": the verdict on the track's first probe, once the learner asked for it and
   * it was written (design §7.1), with the session it came from.
   */
  started: { sessionId: string; verdict: ProbeVerdict } | null;
  /** The plan's arcs in order, each with its picture (its terms and what they rest on). */
  arcs: {
    title: string;
    /** The arc the track has reached: the first with an idea still to come. */
    current: boolean;
    counts: Record<Standing, number>;
    map: TermMap;
  }[];
}

const key = (term: string) => term.trim().toLowerCase();

/** The track page's data (design §8), or null when the learner has no such track. */
export async function trackProgress(
  db: Db,
  userId: string,
  trackId: string,
): Promise<TrackProgress | null> {
  const [track] = await db
    .select({ plan: tracks.plan })
    .from(tracks)
    .where(and(eq(tracks.id, trackId), eq(tracks.userId, userId)));
  if (!track) return null;
  const all = await loadTrackTerms(db, trackId);
  const sessions = (
    await db
      .select({
        id: learningSessions.id,
        createdAt: learningSessions.createdAt,
        closedAt: learningSessions.closedAt,
      })
      .from(learningSessions)
      .where(eq(learningSessions.trackId, trackId))
      .orderBy(asc(learningSessions.createdAt), asc(learningSessions.id))
  ).map((s, i) => ({ ...s, number: i + 1 }));
  // The session a change happened in: sessions of a track never overlap (one open at a time).
  const sessionAt = (at: Date) =>
    sessions.findLast((s) => s.createdAt <= at && (s.closedAt === null || at <= s.closedAt)) ??
    null;

  const ids = all.terms.map((t) => t.id);
  const latest = new Map(
    ids.length
      ? (
          await db
            .selectDistinctOn([termEvents.termId], {
              termId: termEvents.termId,
              evidence: termEvents.evidence,
              toStatus: termEvents.toStatus,
              createdAt: termEvents.createdAt,
            })
            .from(termEvents)
            .where(inArray(termEvents.termId, ids))
            .orderBy(termEvents.termId, desc(termEvents.createdAt), desc(termEvents.id))
        ).map((e) => [e.termId, e])
      : [],
  );
  const nameOf = new Map(all.terms.map((t) => [t.id, t.term]));
  const ideas = all.terms.flatMap((t): Idea[] => {
    const standing = standingOf(t.status, t.from !== null);
    if (standing === "coming") return [];
    const event = latest.get(t.id);
    const session = event ? sessionAt(event.createdAt) : null;
    return [
      {
        term: t.term,
        standing,
        brought: t.status === "assumed",
        ...(t.from ? { from: t.from } : {}),
        restsOn: (all.restsOn.get(t.id) ?? []).map((id) => nameOf.get(id) ?? ""),
        since: (event?.createdAt ?? new Date(0)).toISOString(),
        evidence: event?.evidence ?? "",
        session: session ? { id: session.id, number: session.number } : null,
      },
    ];
  });

  const statusOf = new Map(
    all.terms.map((t) => [key(t.term), standingOf(t.status, t.from !== null)]),
  );
  const current = track.plan.arcs.findIndex((arc) =>
    arc.terms.some((term) => statusOf.get(key(term)) === "coming"),
  );
  const revisit = await db
    .select({ text: fixListItems.text })
    .from(fixListItems)
    .where(and(eq(fixListItems.trackId, trackId), eq(fixListItems.status, "open")))
    .orderBy(fixListItems.createdAt, fixListItems.id);

  return {
    owned: ideas.filter((i) => i.standing === "owned"),
    settling: ideas.filter((i) => i.standing === "settling"),
    coming: all.terms.filter((t) => standingOf(t.status, t.from !== null) === "coming").length,
    revisit: revisit.map((r) => r.text),
    started: await whereYouStarted(db, trackId),
    arcs: track.plan.arcs.map((arc, i) => {
      const counts: Record<Standing, number> = { owned: 0, settling: 0, coming: 0 };
      for (const term of arc.terms) {
        const standing = statusOf.get(key(term));
        if (standing) counts[standing]++;
      }
      return { title: arc.title, current: i === current, counts, map: termMap(all, arc.terms) };
    }),
  };
}
