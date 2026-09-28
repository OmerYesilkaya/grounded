import { z } from "zod";

/*
 * Structured edits the model returns instead of rewriting state (design §5). The server validates a
 * whole batch and applies it only if every edit is valid. Plain unions (JSON Schema anyOf), not
 * discriminated ones: OpenAI's strict structured outputs reject oneOf.
 */

const setTermStatus = z.object({
  type: z.literal("set-term-status"),
  term: z.string().min(1),
  status: z.enum(["taught", "confirmed", "assumed"]),
  /** The learner's own words that justify the change. */
  evidence: z.string(),
});
const addPlannedTerm = z.object({
  type: z.literal("add-planned-term"),
  term: z.string().min(1),
  restsOn: z.array(z.string().min(1)),
});
const addFixItem = z.object({ type: z.literal("add-fix-item"), text: z.string().min(1) });
const closeFixItem = z.object({ type: z.literal("close-fix-item"), text: z.string().min(1) });
const setLanguage = z.object({ type: z.literal("set-language"), language: z.string() });
/**
 * Places terms in the plan and leaves the rest of it as it is: appended to the arc with this title
 * (matched case-insensitively), or, when no arc has it, to a new arc at the end (design §4.4).
 */
const addToArc = z.object({
  type: z.literal("add-to-arc"),
  arc: z.string().min(1),
  terms: z.array(z.string().min(1)),
});
/** Replaces the whole plan, arcs and notes: only from a call that saw all of it (the close). */
const setPlan = z.object({
  type: z.literal("set-plan"),
  arcs: z.array(z.object({ title: z.string().min(1), terms: z.array(z.string()) })),
  notes: z.string(),
});
export const trackActionSchema = z.union([
  setTermStatus,
  addPlannedTerm,
  addFixItem,
  closeFixItem,
  setLanguage,
  addToArc,
  setPlan,
]);

export type TrackAction = z.infer<typeof trackActionSchema>;
