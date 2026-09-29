import { z } from "zod";
import { closeActionSchema, planActionSchema, trackActionSchema } from "./actions.js";

/*
 * The structured calls around a chat message: the message itself is streamed without tools, and its
 * actions and decisions come from a separate structured call (design §7.1).
 */

/**
 * After each of the learner's answers in the opening review, before the next message: what the
 * answers showed, the leaks the learner found, and whether the review is done. When it is, no review
 * message is written; what it found is its own call, and the probe follows.
 */
export const openingReviewDecisionSchema = z.object({
  actions: z
    .array(trackActionSchema)
    .describe(
      "Changes to the track the learner's answers showed, from how they used the terms (with their own words as evidence): a term that held is confirmed, one that didn't goes back to taught; misconceptions as fix-list items. Empty if none.",
    ),
  resolved: z
    .array(z.string())
    .describe(
      "The labels (L1, L2…) of the leaks the learner has now found and put right in their own words. Empty if none.",
    ),
  finished: z
    .boolean()
    .describe(
      "True when every item waiting for the review has been taken up, or the learner asked to move on.",
    ),
});

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

/**
 * Before each of the final's audit questions after the opening one (design §7.4): what the answers
 * showed, the new fix-list among it, and whether the audit is done. When it is, the teach-back
 * follows.
 */
export const auditDecisionSchema = z.object({
  actions: z
    .array(trackActionSchema)
    .describe(
      "Changes to the track the learner's answers showed: term statuses from how they used the terms (with their own words as evidence; a term that didn't hold goes back to taught), and every misconception found as a new fix-list item. Empty if none.",
    ),
  finished: z
    .boolean()
    .describe(
      "True when every strand of the subject has been audited, or the learner asked to move on to the teach-back.",
    ),
});

/**
 * After each of the learner's answers in the final's teach-back: what they showed, where the chain
 * of reasoning broke, and whether it is done. When it is, the close follows.
 */
export const teachBackDecisionSchema = z.object({
  actions: z
    .array(trackActionSchema)
    .describe(
      "Term statuses the learner's explanation showed, with their own words as evidence: a term they rebuilt from what it rests on, under your why and what if, is confirmed. Empty if none.",
    ),
  breaks: z
    .array(
      z.object({
        term: z
          .string()
          .nullable()
          .describe("The term the break is in, as the term list spells it; null if none fits."),
        quote: z
          .string()
          .describe(
            'The learner\'s own words where they had no reason to give ("it just is"), quoted exactly.',
          ),
      }),
    )
    .describe(
      "The places in their latest answer where the chain broke: they had to say it just is, or gave no reason when asked why. Only new ones; empty if none.",
    ),
  finished: z
    .boolean()
    .describe(
      "True when the learner has rebuilt the subject from its foundations as far as they can, or asked to finish.",
    ),
});

export type TeachBackBreak = z.infer<typeof teachBackDecisionSchema>["breaks"][number];

/** After the plan's message: the plan it presented, as edits to the track. */
export const planActionsSchema = z.object({
  actions: z
    .array(planActionSchema)
    .describe(
      "Every planned term with what it rests on (one already in the term list keeps its status and only gains what it rests on); this session's new planned terms placed in the plan's arcs (add-to-arc: the existing arc each belongs to, by its exact title, or a new arc only if none fits); misconceptions found in the probe as fix-list items; and anything you noted for later sessions (add-plan-notes).",
    ),
});

/** The edits of a call asked for again after some were rejected. */
export const trackActionsSchema = z.object({
  actions: z.array(trackActionSchema),
});

/** The close's term sweep: every term settled, and any change to the plan or the fix-list. */
export const sweepActionsSchema = z.object({
  actions: z.array(closeActionSchema),
});

/**
 * A refresh of the learner's teaching notes (design §8): the whole set as it should now stand. A
 * current note left out is removed; one kept may be revised.
 */
export const teachingNotesSchema = z.object({
  notes: z
    .array(
      z.object({
        keeps: z
          .string()
          .nullable()
          .describe(
            "The current note this one keeps or revises, by its label (N1, N2…); null for a new note.",
          ),
        text: z
          .string()
          .describe(
            "Guidance about teaching this learner, in plain words they would recognize. Never a judgment of ability; nothing about vocabulary or terms.",
          ),
        evidence: z
          .array(
            z.object({
              session: z.string().describe("The session, by its label (S1, S2…)."),
              what: z.string().describe("What in it showed the pattern, in a short plain phrase."),
            }),
          )
          .describe(
            "The sessions since the last refresh that show it. A new note needs at least three separate sessions.",
          ),
      }),
    )
    .describe("Every note as it should now stand: about a dozen at most."),
});

export type TeachingNotesRefresh = z.infer<typeof teachingNotesSchema>;
