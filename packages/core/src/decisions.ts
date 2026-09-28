import { z } from "zod";
import { planActionSchema, trackActionSchema } from "./actions.js";

/*
 * The structured calls around a chat message: the message itself is streamed without tools, and its
 * actions and decisions come from a separate structured call (design §7.1).
 */

/**
 * Before each probe question after the opening one: what the learner's answers showed, and whether
 * probing is done. When it is, no probe message is written; the summary for the plan is its own call.
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
});

/** After the plan's message: the plan it presented, as edits to the track. */
export const planActionsSchema = z.object({
  actions: z
    .array(planActionSchema)
    .describe(
      "Every planned term with what it rests on; this session's new planned terms placed in the plan's arcs (add-to-arc: the existing arc each belongs to, by its exact title, or a new arc only if none fits); misconceptions found in the probe as fix-list items; and anything you noted for later sessions (add-plan-notes).",
    ),
});
