import { z } from "zod";
import { trackActionSchema } from "./actions.js";

/*
 * What the model returns after writing a chat message: the message itself is streamed without tools,
 * then a separate structured call records its actions and decisions (design §7.1).
 */

/** After each probe reply: what the learner's answers showed, and whether probing is done. */
export const probeDecisionSchema = z.object({
  actions: z
    .array(trackActionSchema)
    .describe(
      "Changes to the track the learner's answers showed: term statuses (with their own words as evidence), misconceptions as fix-list items, and the teaching language if it isn't recorded yet. Empty if none.",
    ),
  finished: z
    .boolean()
    .describe("True when the learner's level and goal are both clear enough to plan against."),
});

/** After the plan's message: the plan it presented, as edits to the track. */
export const planActionsSchema = z.object({
  actions: z
    .array(trackActionSchema)
    .describe(
      "Every planned term with what it rests on, the plan's arcs in order, and misconceptions found in the probe as fix-list items.",
    ),
});
