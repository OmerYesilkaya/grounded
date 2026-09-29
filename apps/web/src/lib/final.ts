import { queryOptions } from "@tanstack/react-query";
import { api } from "./api";

/** A fix-list item as the final's end shows it: still open, or fixed. */
export interface FixListEntry {
  text: string;
  open: boolean;
}

/**
 * What a final found (api: engine/final.ts; design §7.4): the fix-list the track kept before it,
 * each item as it stands now, the one its fresh audit found, and where the teach-back's chain of
 * reasoning broke, in the learner's words.
 */
export interface FinalOutcome {
  before: FixListEntry[];
  found: FixListEntry[];
  breaks: { term: string | null; quote: string }[];
  /** When the final closed; null while it is under way. */
  closedAt: string | null;
}

export const finalQuery = (sessionId: string) =>
  queryOptions({
    queryKey: ["final", sessionId],
    queryFn: () => api<FinalOutcome>(`/api/sessions/${sessionId}/final`),
  });
