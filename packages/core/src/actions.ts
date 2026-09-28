import { z } from "zod";

/*
 * Structured edits the model returns instead of rewriting state (design §5). The server validates
 * every edit of a batch against the track as the edits before it leave it. Plain unions (JSON Schema anyOf), not
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
/**
 * Replaces the plan's arcs, and its notes unless `notes` is null (the notes are then kept as they
 * are): only from a call that saw all of it (the close).
 */
const setPlan = z.object({
  type: z.literal("set-plan"),
  arcs: z.array(z.object({ title: z.string().min(1), terms: z.array(z.string()) })),
  notes: z.string().nullable(),
});
/**
 * Edits one section of the plan's notes: the section under this heading line (as written, e.g.
 * "## Open threads", up to the next heading of its level or above) gets `text` as its body, or is
 * removed when `text` is null; a heading no section has adds a new section at the end. Only from a
 * call that saw the notes as written (the close; design §5).
 */
const editPlanNotes = z.object({
  type: z.literal("edit-plan-notes"),
  heading: z.string().min(1),
  text: z.string().nullable(),
});
/**
 * Borrows a term the learner holds in another of their tracks (design §5): `term` as this track
 * names it (in its teaching language), `from` as the other track's term list spells it. The server
 * checks the other track holds it; the term is then usable here as held and isn't taught again.
 */
const borrowTerm = z.object({
  type: z.literal("borrow-term"),
  term: z.string().min(1),
  from: z.string().min(1),
});
/** Notes for later sessions, added after the plan's notes (from a call that didn't see them). */
const addPlanNotes = z.object({ type: z.literal("add-plan-notes"), notes: z.string() });

/** What any call may record: terms, the fix-list, the language, and terms placed in the plan's arcs. */
export const trackActionSchema = z.union([
  setTermStatus,
  addPlannedTerm,
  addFixItem,
  closeFixItem,
  setLanguage,
  addToArc,
]);

/**
 * What the close's term sweep may return: the track actions, plus rewriting the plan (its arcs, or
 * its notes by section), since the close sees all of it: every arc's terms and the notes as written.
 */
export const closeActionSchema = z.union([
  setTermStatus,
  addPlannedTerm,
  addFixItem,
  closeFixItem,
  setLanguage,
  addToArc,
  setPlan,
  editPlanNotes,
]);

/**
 * What the plan's record may return: the track actions, plus the notes it adds and terms borrowed
 * from the learner's other tracks. A session's plan never rewrites the plan (it places its terms
 * with add-to-arc).
 */
export const planActionSchema = z.union([
  borrowTerm,
  setTermStatus,
  addPlannedTerm,
  addFixItem,
  closeFixItem,
  setLanguage,
  addToArc,
  addPlanNotes,
]);

export type TrackAction = z.infer<typeof closeActionSchema> | z.infer<typeof planActionSchema>;
