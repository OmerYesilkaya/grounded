import type { Phase, PlanArc, TermRow, TermStatus } from "./prompt.js";

/**
 * The phases whose calls record the plan (the plan's record, the close's sweep, the final's audit):
 * they see every arc with its terms, since a set-plan replaces the whole plan. The others see the
 * current arc's terms and every other arc as a tally (design §4.4).
 */
export const WHOLE_PLAN_PHASES: readonly Phase[] = ["plan", "close", "final"];

/**
 * The phase that reads the plan's notes as written: the close, whose sweep updates them and which
 * then writes "where you left off" from them. Every other call carries that summary instead.
 */
export const NOTES_PHASES: readonly Phase[] = ["close"];

export interface TrackViewInput {
  /** Every term of the track, in the term list's order. */
  terms: readonly TermRow[];
  arcs: readonly { title: string; terms: readonly string[] }[];
  /** Terms touched recently (design §4.4), by name. */
  touched: Iterable<string>;
  wholePlan: boolean;
}

export interface TrackView {
  /** The terms the prompt lists: the current arc's, the recently touched, and all they rest on. */
  terms: TermRow[];
  /** The rest, counted by status. */
  termsNotListed: Partial<Record<TermStatus, number>>;
  arcs: PlanArc[];
}

const key = (term: string) => term.trim().toLowerCase();

/**
 * What of a large track a prompt carries (design §4.4): the current arc (the first in plan order
 * with a planned term), the terms touched recently, and everything those rest on, transitively.
 * Pure, and ordered as the input, so the same track renders the same way on every load.
 */
export function selectTrackView(input: TrackViewInput): TrackView {
  const byKey = new Map(input.terms.map((t) => [key(t.term), t]));
  const current = input.arcs.findIndex((arc) =>
    arc.terms.some((term) => byKey.get(key(term))?.status === "planned"),
  );

  const listed = new Set<string>();
  const pending = [...(input.arcs[current]?.terms ?? []), ...input.touched].map(key);
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const term = byKey.get(next);
    if (!term || listed.has(next)) continue;
    listed.add(next);
    pending.push(...term.restsOn.map(key));
  }

  const terms = input.terms.filter((t) => listed.has(key(t.term)));
  const termsNotListed = tally(input.terms.filter((t) => !listed.has(key(t.term))));
  const arcs = input.arcs.map((arc, i): PlanArc => {
    const shown = {
      title: arc.title,
      terms: arc.terms,
      ...(i === current ? { current: true } : {}),
    };
    if (input.wholePlan || i === current) return shown;
    const statuses = arc.terms.flatMap((term) => byKey.get(key(term)) ?? []);
    return { ...shown, tally: tally(statuses) };
  });
  return { terms, termsNotListed, arcs };
}

function tally(terms: readonly TermRow[]): Partial<Record<TermStatus, number>> {
  const counts: Partial<Record<TermStatus, number>> = {};
  for (const { status } of terms) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}
