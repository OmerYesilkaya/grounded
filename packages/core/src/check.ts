import { z } from "zod";
import { trackActionSchema } from "./actions.js";

/** What the model returns when it grades a check (method.md, "Checks inside the lesson"). */
export const checkVerdictSchema = z.object({
  verdict: z.enum(["landed", "missed"]),
  /** Landed: a few words. Missed: the repair of that one piece, rebuilt from what it rests on. */
  reply: z.string().min(1),
  /** Missed and still repairing: a fresh question on the same idea, never the same question. */
  freshQuestion: z.string().optional(),
  /** Missed: where the step leaked, in two or three sentences, for the note under the step. */
  note: z.string().optional(),
  /** Term changes from how the learner used the terms, with their words as evidence. */
  actions: z.array(trackActionSchema),
});

export type CheckVerdict = z.infer<typeof checkVerdictSchema>;
