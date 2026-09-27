import { z } from "zod";

/**
 * Structured edits the model returns instead of rewriting state (design §5). The server validates a
 * whole batch and applies it only if every edit is valid. A plain union (JSON Schema anyOf), not a
 * discriminated one: OpenAI's strict structured outputs reject oneOf.
 */
export const trackActionSchema = z.union([
  z.object({
    type: z.literal("set-term-status"),
    term: z.string().min(1),
    status: z.enum(["taught", "confirmed", "assumed"]),
    /** The learner's own words that justify the change. */
    evidence: z.string(),
  }),
  z.object({
    type: z.literal("add-planned-term"),
    term: z.string().min(1),
    restsOn: z.array(z.string().min(1)),
  }),
  z.object({ type: z.literal("add-fix-item"), text: z.string().min(1) }),
  z.object({ type: z.literal("close-fix-item"), text: z.string().min(1) }),
  z.object({
    type: z.literal("set-plan"),
    arcs: z.array(z.object({ title: z.string().min(1), terms: z.array(z.string()) })),
    notes: z.string(),
  }),
]);

export type TrackAction = z.infer<typeof trackActionSchema>;
