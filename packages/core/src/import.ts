import { z } from "zod";
import { trackActionSchema } from "./actions.js";

/**
 * What the one-time import of a track kept elsewhere returns (design §10): the track's knowledge
 * state as the same edits a session makes, plus what the model couldn't express as an edit.
 */
export const importActionsSchema = z.object({
  actions: z
    .array(trackActionSchema)
    .describe(
      "The whole track as edits, in an order where every term exists before anything rests on it: the teaching language, assumed terms, every other term as a planned term with what it rests on, then the taught and confirmed statuses with their evidence, open misconceptions as fix-list items, and one set-plan with the arcs.",
    ),
  unplaced: z
    .array(z.string())
    .describe(
      "Anything in the state that couldn't be expressed as an edit, one short line each. Empty if everything was placed.",
    ),
});

export type ImportActions = z.infer<typeof importActionsSchema>;
