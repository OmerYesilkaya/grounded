import { z } from "zod";
import { trackActionSchema } from "./actions.js";
import {
  TASK_FORM_SPECS,
  type AssignmentKind,
  type ChecklistItem,
  type TaskForm,
} from "./assignment.js";
import { allowedBlocksLine } from "./blocks-line.js";

/*
 * The review of handed-in homework or an arc exam (design §7.4, method.md "Review"): comments in
 * the margin, each on the part of the answer where the learner's model leaked, Socratic, with
 * replies in the card; and each item of "what a good answer demonstrates" marked, with no score.
 */

/** How the review marks an item of "what a good answer demonstrates". */
export const REVIEW_MARKS = ["held", "leaked", "missing"] as const;
export type ReviewMark = (typeof REVIEW_MARKS)[number];

/** An item of the checklist as the review marked it, with a line for the learner. */
export interface ChecklistMark {
  /** The item's id (c1, c2…). */
  id: string;
  mark: ReviewMark;
  note: string;
}

/**
 * Where a margin comment hangs: a task's answer field, and the passage of it quoted, with a little
 * of the text around it (as an aside's anchor, design §7.5). An empty quote is the field as a
 * whole: a picture, or something the answer leaves out.
 */
export interface ReviewAnchor {
  taskId: string;
  /** The answer field's key (prediction, step-2…). */
  field: string;
  quote: string;
  prefix: string;
  suffix: string;
}

export const REVIEW_LIMITS = {
  /** Comments kept of one review: the leaks that matter most. */
  comments: 8,
  /** Characters of the text around a quote kept in its anchor. */
  context: 64,
  /** Characters of a reply in a comment's card. */
  reply: 2000,
} as const;

/** What the review call returns. Every key is required: strict structured outputs reject optional ones. */
export const assignmentReviewSchema = z.object({
  comments: z
    .array(
      z.object({
        task: z.string().describe("The task's id, as its heading gives it (t1)."),
        field: z.string().describe("The answer field it is about, as its [field: …] gives it."),
        quote: z
          .string()
          .describe(
            "The words of the answer it is about, copied exactly as the learner wrote them, without markdown: a few words to a sentence. Empty for the field as a whole (a picture).",
          ),
        items: z
          .array(z.string())
          .describe("The ids of the checklist items it bears on (c1, c2…); empty if none."),
        comment: z
          .string()
          .min(1)
          .describe(
            "For the learner: where their model leaked, pointed at, and a question that sets them finding the flaw themselves. Never the corrected answer. A few sentences at most.",
          ),
      }),
    )
    .describe(
      "Comments in the margin, only where the learner's model leaked; none where it held. The ones that matter most, at most six.",
    ),
  checklist: z
    .array(
      z.object({
        item: z.string().describe("The item's id (c1, c2…)."),
        mark: z.enum(REVIEW_MARKS),
        note: z
          .string()
          .describe(
            "For the learner, one line. Held: where the answer shows it. Leaked: what to look at again. Missing: a question that sets them looking for it, never the answer.",
          ),
      }),
    )
    .describe("Every item of what a good answer demonstrates, each marked once."),
  actions: z
    .array(trackActionSchema)
    .describe(
      "Term changes from how the learner used the terms in their answer, with their words as evidence: correct use confirms, misuse goes back to taught. Misconceptions as fix-list items. Empty if none.",
    ),
});

export type AssignmentReview = z.infer<typeof assignmentReviewSchema>;

export const REVIEW_REQUEST = `(For the app; the learner doesn't see this.) Review the learner's answers above, as the review section of the method says: comments in the margin on the exact part of the answer each is about, Socratic, pointing at the leak and asking the learner to find the flaw; each item of what a good answer demonstrates marked held, leaked or missing, with no score; and the term changes their use of the terms shows. Nothing is said where the answer holds; no praise to fill space. The learner reads each comment in a card beside their answer and can reply there. ${allowedBlocksLine("review", "a comment")}`;

/** After the learner's reply in a comment's card, and the tutor's answer to it. */
export const reviewReplyRecordSchema = z.object({
  resolved: z
    .boolean()
    .describe(
      "True when the learner has now found the flaw this comment pointed at and put it right in their own words; false while it still leaks.",
    ),
});

export const REVIEW_REPLY_RECORD_PROMPT =
  "(For the app; the learner doesn't see this.) Has the learner now found the flaw this comment pointed at, and put it right in their own words?";

/**
 * Where a quote sits in a field's text (`answerText` in @grounded/content), with the text around
 * it; null when the answer doesn't say it. A quote a model copied with the answer's markdown in it,
 * or with its line breaks as spaces, is found too.
 */
export function placeQuote(
  text: string,
  quote: string,
): Pick<ReviewAnchor, "quote" | "prefix" | "suffix"> | null {
  const around = (at: number, found: string) => ({
    quote: found,
    prefix: text.slice(Math.max(0, at - REVIEW_LIMITS.context), at),
    suffix: text.slice(at + found.length, at + found.length + REVIEW_LIMITS.context),
  });
  const wanted = quote.trim();
  if (wanted === "") return null;
  const exact = text.indexOf(wanted);
  if (exact !== -1) return around(exact, wanted);
  // Loosely: markdown's marks left out, and any run of spaces or line breaks as one.
  const words = wanted
    .replace(/[*_`$]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return null;
  const loose = new RegExp(words.join("\\s+")).exec(text);
  return loose ? around(loose.index, loose[0]) : null;
}

/** An answer field's label as the learner saw it: "Your prediction", "Step 2", "Step 2, because…". */
export function fieldLabel(form: TaskForm, key: string): string {
  const step = /^(step|because)-(\d+)$/.exec(key);
  if (form === "derivation" && step)
    return step[1] === "step" ? `Step ${step[2] ?? ""}` : `Step ${step[2] ?? ""}, because…`;
  return TASK_FORM_SPECS[form].fields.find((f) => f.key === key)?.label ?? key;
}

/** A reviewed assignment as other calls read it: the close, the teaching notes, the next session. */
export interface ReviewedAssignment {
  title: string;
  kind: AssignmentKind;
  checklist: readonly ChecklistItem[];
  marks: readonly ChecklistMark[];
  comments: readonly {
    /** The answer field's label, as the learner saw it ("Your prediction"). */
    field: string;
    quote: string;
    messages: readonly { role: "learner" | "tutor"; text: string }[];
    resolved: boolean;
    /** A label for a call to name it by (L1, L2…: the opening review's leaks still open). */
    label?: string;
  }[];
}

/** A review in words, for a prompt: each item's mark, then each comment with its thread. */
export function reviewRecord(review: ReviewedAssignment): string {
  const what = review.kind === "exam" ? "arc exam" : "homework";
  const items = review.checklist.map((item) => {
    const mark = review.marks.find((m) => m.id === item.id);
    return `- ${mark ? mark.mark : "not marked"}: ${item.text}${mark?.note ? ` (${mark.note})` : ""}`;
  });
  const comments = review.comments.map((comment) => {
    const where = comment.quote ? `«${comment.quote}» in ${comment.field}` : comment.field;
    const thread = comment.messages.map(
      (m) => `  ${m.role === "learner" ? "Learner" : "Tutor"}: ${m.text}`,
    );
    const state = comment.resolved ? "the learner found the flaw" : "still open";
    const label = comment.label ? `${comment.label}, on` : "On";
    return [`- ${label} ${where} (${state}):`, ...thread].join("\n");
  });
  return [
    `### "${review.title}" (${what})`,
    `What a good answer demonstrates:\n${items.join("\n")}`,
    comments.length
      ? `Comments in the margin:\n${comments.join("\n")}`
      : "No comments: nothing leaked.",
  ].join("\n\n");
}
