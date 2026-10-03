/** The filters every view takes (design §10.1), kept in the address so a view can be shared. */
export interface Filters {
  /** Days, or all time; 30 when unset. */
  period?: 7 | 30 | 90 | "all" | undefined;
  model?: string | undefined;
  method?: string | undefined;
}

export const PERIODS = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: "all", label: "All time" },
] as const;

/** The period in the address: the router reads `period=90` as the number 90. */
const periodOf = (value: unknown): Filters["period"] =>
  PERIODS.find((p) => String(p.value) === String(value))?.value;

/** A text value from the address; one that reads as a number comes back a number, so it is turned back. */
const text = (value: unknown) =>
  (typeof value === "string" && value !== "") || typeof value === "number"
    ? String(value)
    : undefined;

export function validateFilters(search: Record<string, unknown>): Filters {
  return {
    period: periodOf(search.period),
    model: text(search.model),
    method: text(search.method),
  };
}

/** What sessions to list, besides the filters: the overview's figures link here with these. */
export interface SessionSearch extends Filters {
  learner?: number | undefined;
  track?: string | undefined;
  issue?: string | undefined;
  has?: string | undefined;
  phase?: string | undefined;
  before?: string | undefined;
}

export function validateSessionSearch(search: Record<string, unknown>): SessionSearch {
  const learner = Number(search.learner);
  return {
    ...validateFilters(search),
    learner: Number.isInteger(learner) && learner > 0 ? learner : undefined,
    track: text(search.track),
    issue: text(search.issue),
    has: text(search.has),
    phase: text(search.phase),
    before: text(search.before),
  };
}

/** The filters alone, for a link that carries them to another view. */
export const filtersOf = ({ period, model, method }: Filters): Filters => ({
  period,
  model,
  method,
});
