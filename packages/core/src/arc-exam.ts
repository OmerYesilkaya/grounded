import type { TermStatus } from "./prompt.js";

/*
 * Arc exams (design §7.4, method.md "The arc exam"): the session that closes an arc's last step
 * assigns an exam over the whole arc, besides its homework. Which session closes an arc is the
 * app's to work out, from the plan's arcs and the lesson, as the checks' places are (§7.3): the
 * model can't name it wrongly, and it can be tested.
 */

/** An arc of the plan, as `tracks.plan` keeps it. */
export interface ArcOfPlan {
  title: string;
  terms: readonly string[];
  /** The session that closed it and assigned its exam; absent while it is open. */
  closedIn?: string | undefined;
}

const key = (term: string) => term.trim().toLowerCase();

/**
 * The arcs this session closes, in plan order: those still open whose terms are all taught once
 * its lesson has taught what it introduces (none left `planned`), and which, when the session
 * began, were under way but not done (one of their terms was planned then, and one wasn't).
 * - A session only closes an arc it finished: an arc taught before the app kept arcs (an imported
 *   track's) is not closed by the lesson that teaches one of its terms again.
 * - An arc one session teaches whole has no exam: its homework covers that ground, and there are
 *   no sessions to connect (method.md: arcs group sessions, where a subject is larger than one).
 */
export function arcsClosedBy(input: {
  arcs: readonly ArcOfPlan[];
  /** Each term's status as the session began, by name; a term added since was planned. */
  before: ReadonlyMap<string, TermStatus>;
  /** Each term's status now, by name. */
  now: ReadonlyMap<string, TermStatus>;
  /** The terms the session's lesson introduces. */
  introduced: readonly string[];
}): ArcOfPlan[] {
  const status = (map: ReadonlyMap<string, TermStatus>) => {
    const byKey = new Map([...map].map(([term, s]) => [key(term), s]));
    return (term: string) => byKey.get(key(term));
  };
  const before = status(input.before);
  const now = status(input.now);
  const introduced = new Set(input.introduced.map(key));
  return input.arcs.filter(
    (arc) =>
      !arc.closedIn &&
      arc.terms.length > 0 &&
      arc.terms.some((term) => (before(term) ?? "planned") === "planned") &&
      arc.terms.some((term) => (before(term) ?? "planned") !== "planned") &&
      arc.terms.every(
        (term) => introduced.has(key(term)) || (now(term) ?? "planned") !== "planned",
      ),
  );
}

/**
 * The arcs after a `set-plan` (design §5): an arc keeps being closed, by the session that closed
 * it, under its title (matched case-insensitively) or, renamed, with the same terms. The close
 * that rewrites the arcs sees which are closed; nothing else knows it.
 */
export function keepClosedArcs<Arc extends { title: string; terms: readonly string[] }>(
  before: readonly ArcOfPlan[],
  after: readonly Arc[],
): (Arc & { closedIn?: string })[] {
  const closed = before.filter((arc) => arc.closedIn);
  const termsKey = (terms: readonly string[]) => terms.map(key).toSorted().join("\n");
  return after.map((arc) => {
    const same =
      closed.find((c) => key(c.title) === key(arc.title)) ??
      closed.find((c) => termsKey(c.terms) === termsKey(arc.terms));
    return same?.closedIn ? { ...arc, closedIn: same.closedIn } : arc;
  });
}
