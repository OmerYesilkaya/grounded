import { z } from "zod";
import { trackActionSchema } from "./actions.js";

/*
 * The structured calls around a chat message: the message itself is streamed without tools, and its
 * actions and decisions come from a separate structured call (design §7.1).
 */

/**
 * Before each probe question after the opening one: what the learner's answers showed, and whether
 * probing is done. When it is, no probe message is written, and the summary goes to the plan.
 */
export const probeDecisionSchema = z.object({
  actions: z
    .array(trackActionSchema)
    .describe(
      "Changes to the track the learner's answers showed: term statuses (with their own words as evidence), misconceptions as fix-list items, and the teaching language if it isn't recorded yet. Empty if none.",
    ),
  finished: z
    .boolean()
    .describe(
      "True when the learner's level and goal are both clear enough to plan against, or the learner asked to move on to the plan.",
    ),
  summary: z
    .string()
    .nullable()
    .describe(
      "When finished: where the learner's knowledge ends (what they hold and where it stops, for each strand the lesson will lean on) and what they want to reach, for the plan. Null when not finished.",
    ),
});

/** After the plan's message: the plan it presented, as edits to the track. */
export const planActionsSchema = z.object({
  actions: z
    .array(trackActionSchema)
    .describe(
      "Every planned term with what it rests on, the plan's arcs in order, and misconceptions found in the probe as fix-list items.",
    ),
});
