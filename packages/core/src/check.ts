import { z } from "zod";
import { trackActionSchema } from "./actions.js";

/**
 * What the model returns when it grades a check (method.md, "Checks inside the lesson"). Every key is
 * required (null when unused): strict structured outputs reject optional properties.
 */
export const checkVerdictSchema = z.object({
  verdict: z.enum(["landed", "missed"]),
  /** Landed: a few words. Missed: the repair of that one piece, rebuilt from what it rests on. */
  reply: z.string().min(1),
  /** Missed and still repairing: a fresh question on the same idea, never the same question; else null. */
  freshQuestion: z.string().nullable(),
  /** Missed: where the step leaked, in two or three sentences, for the note under the step; else null. */
  note: z.string().nullable(),
  /** Term changes from how the learner used the terms, with their words as evidence. */
  actions: z.array(trackActionSchema),
});

export type CheckVerdict = z.infer<typeof checkVerdictSchema>;
