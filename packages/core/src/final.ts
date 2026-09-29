import type { TeachBackBreak } from "./decisions.js";
import type { TrackAction } from "./actions.js";

/*
 * The final (design §7.4, method.md "The final"): a track ends with a session of its own, a fresh
 * audit and a teach-back, with no plan, lesson or homework. When it is offered is the app's to work
 * out from the plan and the track's work, as which session closes an arc is (arc-exam.ts).
 */

/** Where a track stands towards its final. */
export type FinalStanding =
  /** The plan isn't taught through yet, or the track has no plan: no final yet. */
  | "not-yet"
  /** The plan is taught through, but an arc exam is still open: the final comes once it is in. */
  | "after-exam"
  /** The plan is taught through and every arc exam handed in: the final is offered. */
  | "ready"
  /** The track's latest session is its final, closed: the track is finished. */
  | "finished";

const key = (term: string) => term.trim().toLowerCase();

/**
 * Where a track stands towards its final (design §7.4). The plan is taught through when it has
 * arcs and none of their terms is still planned: the last arc's lesson is behind the learner. The
 * final then waits for every arc exam to be handed in, since the last arc's exam is the build the
 * method puts before it, and the final's opening review takes it up. A session after a final makes
 * the track unfinished again: its new fix-list became sessions, and when their arcs are taught
 * through, a final is offered again.
 */
export function finalStanding(input: {
  arcs: readonly { terms: readonly string[] }[];
  /** The track's terms still planned, by name. */
  planned: Iterable<string>;
  /** How many of the track's arc exams are still open. */
  examsOpen: number;
  /** The track's latest session, if it has one. */
  latest: { final: boolean; closed: boolean } | null;
}): FinalStanding {
  if (input.latest?.final && input.latest.closed) return "finished";
  const planned = new Set([...input.planned].map(key));
  const taughtThrough =
    input.arcs.length > 0 &&
    input.arcs.every((arc) => arc.terms.every((t) => !planned.has(key(t))));
  if (!taughtThrough) return "not-yet";
  return input.examsOpen > 0 ? "after-exam" : "ready";
}

/** The statuses a term is held at, which a break in the teach-back takes back to taught. */
const HELD = new Set(["confirmed", "assumed", "borrowed"]);

/**
 * What the teach-back's breaks change (method.md, "The final"): a term the learner could only say
 * "it just is" about was memorized, not understood, so a held one goes back to taught, with their
 * words as the evidence, and the next session rebuilds it. The app derives it from the marks, so a
 * break is never marked without its term following.
 */
export function breakDemotions(
  breaks: readonly TeachBackBreak[],
  terms: readonly { term: string; status: string }[],
): TrackAction[] {
  const statusOf = new Map(terms.map((t) => [key(t.term), t.status]));
  const demoted = new Set<string>();
  return breaks.flatMap((b): TrackAction[] => {
    const term = b.term?.trim();
    if (!term || !HELD.has(statusOf.get(key(term)) ?? "") || demoted.has(key(term))) return [];
    demoted.add(key(term));
    return [
      {
        type: "set-term-status",
        term,
        status: "taught",
        evidence: `Couldn't say why in the final's teach-back: “${b.quote.trim()}”`,
      },
    ];
  });
}
