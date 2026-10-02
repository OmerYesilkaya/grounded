import type { TrackAction } from "@grounded/core";
import {
  eq,
  inArray,
  termDependencies,
  terms,
  tracks,
  type Db,
  type TermStatus,
} from "@grounded/db";

/*
 * The pictures of what rests on what (design §3.2, §9.1): drawn by the app from the term
 * dependencies, never by the model. A picture is drawn around some terms (its focus: a plan's
 * terms, a lesson's, an arc's) with what they rest on directly, so it stays small enough to read.
 */

/**
 * Where the learner stands with a term, in the words the learner sees (design §8): never the
 * method's statuses. Confirmed, assumed and borrowed terms are owned; taught ones still settling;
 * planned ones coming up.
 */
export type Standing = "owned" | "settling" | "coming";

export interface MapNode {
  term: string;
  standing: Standing;
  /** One of the terms the picture is drawn around; the others are what they rest on. */
  focus: boolean;
  /** The track a borrowed term is held in. */
  from?: string;
}

export interface TermMap {
  /** In the term list's order. */
  nodes: MapNode[];
  /** `term` rests on `restsOn`; both are in `nodes`. */
  edges: { term: string; restsOn: string }[];
}

/** A track's terms with what each rests on, as the pictures and the track page read them. */
export interface TrackTerms {
  terms: { id: string; term: string; status: TermStatus; from: string | null }[];
  /** Term id to the ids it rests on, in the term list's order. */
  restsOn: Map<string, string[]>;
}

const key = (term: string) => term.trim().toLowerCase();

export function standingOf(status: TermStatus, borrowed: boolean): Standing {
  if (borrowed || status === "confirmed" || status === "assumed") return "owned";
  return status === "taught" ? "settling" : "coming";
}

export async function loadTrackTerms(db: Db, trackId: string): Promise<TrackTerms> {
  const rows = await db
    .select({
      id: terms.id,
      term: terms.term,
      status: terms.status,
      borrowedFrom: terms.borrowedFrom,
    })
    .from(terms)
    .where(eq(terms.trackId, trackId))
    .orderBy(terms.createdAt, terms.id);
  const ids = rows.map((r) => r.id);
  const sources = rows.flatMap((r) => (r.borrowedFrom ? [r.borrowedFrom] : []));
  const from = new Map(
    sources.length
      ? (
          await db
            .select({ id: terms.id, track: tracks.title })
            .from(terms)
            .innerJoin(tracks, eq(tracks.id, terms.trackId))
            .where(inArray(terms.id, sources))
        ).map((s) => [s.id, s.track])
      : [],
  );
  const deps = ids.length
    ? await db.select().from(termDependencies).where(inArray(termDependencies.termId, ids))
    : [];
  const position = new Map(ids.map((id, i) => [id, i]));
  const restsOn = new Map<string, string[]>();
  for (const d of deps.toSorted(
    (a, b) => (position.get(a.restsOnTermId) ?? 0) - (position.get(b.restsOnTermId) ?? 0),
  ))
    restsOn.set(d.termId, [...(restsOn.get(d.termId) ?? []), d.restsOnTermId]);
  return {
    terms: rows.map((r) => ({
      id: r.id,
      term: r.term,
      status: r.status,
      from: r.borrowedFrom ? (from.get(r.borrowedFrom) ?? null) : null,
    })),
    restsOn,
  };
}

/**
 * The picture around `focus` (term names, matched ignoring case): those terms, what they rest on
 * directly, and a line from each of those terms to each thing it rests on. Names the track doesn't
 * have are left out. Pure.
 */
export function termMap(track: TrackTerms, focus: readonly string[]): TermMap {
  const wanted = new Set(focus.map(key));
  const focused = track.terms.filter((t) => wanted.has(key(t.term)));
  const shown = new Set(focused.map((t) => t.id));
  for (const t of focused) for (const id of track.restsOn.get(t.id) ?? []) shown.add(id);
  const nameOf = new Map(track.terms.map((t) => [t.id, t.term]));
  const nodes = track.terms
    .filter((t) => shown.has(t.id))
    .map((t): MapNode => ({
      term: t.term,
      standing: standingOf(t.status, t.from !== null),
      focus: wanted.has(key(t.term)),
      ...(t.from ? { from: t.from } : {}),
    }));
  // Only the focus's own lines: what the ground rests on in turn belongs to another picture.
  const edges = focused.flatMap((t) =>
    (track.restsOn.get(t.id) ?? []).map((id) => ({ term: t.term, restsOn: nameOf.get(id) ?? "" })),
  );
  return { nodes, edges };
}

/**
 * The terms a plan's record planned, in its order: what the plan's picture is drawn around. A term
 * it placed in an arc after the current one (the first in plan order with a planned term) is the
 * route beyond this session, as a track's first plan lays it out, and is left out: the picture is
 * the ground this session covers. A revised plan's record plans only what the revision added, so
 * `earlier`, the terms of the plan it revises in this session, comes first: the ground it still
 * covers, less what the revision moved to a later arc. `arcs` and `track` are as the record left
 * them. Pure.
 */
export function plannedIn(
  actions: readonly TrackAction[],
  arcs: readonly { terms: readonly string[] }[],
  track: TrackTerms,
  earlier: readonly string[] = [],
): string[] {
  const status = new Map(track.terms.map((t) => [key(t.term), t.status]));
  const current = arcs.findIndex((arc) => arc.terms.some((t) => status.get(key(t)) === "planned"));
  const later = new Set(
    current < 0 ? [] : arcs.slice(current + 1).flatMap((a) => a.terms.map(key)),
  );
  const placed = new Set(actions.flatMap((a) => (a.type === "add-to-arc" ? a.terms.map(key) : [])));
  const names = new Map<string, string>();
  for (const term of earlier) {
    const name = key(term);
    if (names.has(name) || !status.has(name) || later.has(name)) continue;
    names.set(name, term);
  }
  for (const action of actions) {
    if (action.type !== "add-planned-term") continue;
    const name = key(action.term);
    if (names.has(name) || (placed.has(name) && later.has(name))) continue;
    names.set(name, action.term.trim());
  }
  return [...names.values()];
}
