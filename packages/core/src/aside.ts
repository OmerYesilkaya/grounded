import { ALLOWED_BLOCKS, type BlockType } from "@grounded/content";
import { z } from "zod";
import { ASIDE_LIMITS, type AsideAnchor } from "./aside-anchor.js";

/*
 * Asides (design §7.5, method.md "Asides — answering in the margin"): a question the learner asks
 * on a passage of the lesson, answered in the margin by the cheaper model, with follow-ups in the
 * same card.
 */

export { ASIDE_LIMITS, stepOfBlock, type AsideAnchor } from "./aside-anchor.js";

export const asideAnchorSchema = z.object({
  blockId: z.string().regex(/^s\d+\.b\d+(?:\.\d+)*$/),
  quote: z.string().trim().min(1).max(ASIDE_LIMITS.quote),
  prefix: z.string().max(ASIDE_LIMITS.context),
  suffix: z.string().max(ASIDE_LIMITS.context),
});

/**
 * What the app records after an aside's answer (a small structured call of its own, so the answer
 * streams without waiting for it). Every key is required: strict structured outputs reject optional
 * properties. An aside never changes a term's status (method.md): its evidence is kept as it is, for
 * the checks, the close and the next session.
 */
export const asideRecordSchema = z.object({
  evidence: z
    .array(
      z.object({
        term: z.string().min(1).describe("A term from the term list, spelled as the list has it."),
        evidence: z
          .string()
          .min(1)
          .describe(
            "What the learner's question shows about their hold on this term, in a sentence, quoting their words.",
          ),
      }),
    )
    .describe(
      "Terms on the term list that the learner's latest question shows something about: a term they didn't hold that the lesson assumed, one they mixed up, or one they used well. Empty if none.",
    ),
  tangent: z
    .string()
    .nullable()
    .describe(
      'If your answer offered to save a tangent for a future session: the tangent, in a few words the learner would recognize ("Why databases use locks"). Else null.',
    ),
});

export type AsideRecord = z.infer<typeof asideRecordSchema>;

export const ASIDE_RECORD_PROMPT =
  "(For the app; the learner doesn't see this.) Record what the learner's latest question in this aside showed about the terms on the term list, with their words as evidence; this changes no term's status. Then, if your answer offered to save a tangent for a future session, name it.";

/** One message of an aside's thread, as stored. */
export interface AsideTurn {
  role: "learner" | "tutor";
  text: string | null;
}

/** An aside with its thread, as the prompts see it. */
export interface AsideThread {
  stepId: string;
  quote: string;
  messages: readonly AsideTurn[];
  /** The tangent the learner saved for a future session, if they did. */
  saved?: string | null;
}

const BLOCK_NAMES: Partial<Record<BlockType, string>> = {
  paragraph: "paragraphs",
  list: "lists",
  quote: "quotes",
  code: "code",
  math: "maths",
  table: "tables",
  diagram: "diagrams",
  stepper: "steppers",
  about: "preview cards (:::about) for a person, place or work",
};

/** The blocks an answer in the margin may use (design §6.3), for its prompt. */
export function asideBlocksLine(): string {
  const names = ALLOWED_BLOCKS.aside.map((type) => BLOCK_NAMES[type] ?? type);
  return `Blocks you may use in this answer: ${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}. Nothing else is shown.`;
}

export interface AsideLessonStep {
  id: string;
  heading: string;
  /** The step's markdown as written; null while it isn't written yet. */
  source: string | null;
  /** The learner can read it: every check before it has landed or been continued past. */
  open: boolean;
}

/**
 * The whole lesson for an aside's prompt, each step marked with whether the learner has reached
 * it, so the answer can give a taste of what a later step builds without spoiling it.
 */
export function asideLesson(steps: readonly AsideLessonStep[]): string {
  return steps
    .map((step, index) => {
      const number = String(index + 1);
      if (step.source === null) return `### Step ${number} (not written yet): ${step.heading}`;
      const where = step.open
        ? "the learner can read it"
        : "still locked: the learner hasn't reached it; don't spoil it";
      return `### Step ${number} (${where})\n\n${step.source}`;
    })
    .join("\n\n");
}

/** The passage an aside is about, in its step, with the text around it. */
export function asidePassage(
  anchor: Pick<AsideAnchor, "quote" | "prefix" | "suffix">,
  step: { number: number; heading: string },
): string {
  const around = `…${anchor.prefix}«${anchor.quote}»${anchor.suffix}…`;
  return `In step ${String(step.number)}, "${step.heading}", the learner selected the passage between « and »:\n\n${around}`;
}

/**
 * Asides as a record for another call: the earlier asides of this lesson for an aside, or every aside
 * for the checks, the close and the next session (design §7.5). Null when there are none.
 */
export function asideRecord(
  threads: readonly AsideThread[],
  stepNumber: (stepId: string) => number,
): string | null {
  const entries = threads.map((aside) => {
    const lines = [
      `### On step ${String(stepNumber(aside.stepId))}: «${aside.quote}»`,
      ...aside.messages.map(
        (m) => `${m.role === "learner" ? "Learner" : "Tutor"}: ${m.text ?? ""}`,
      ),
    ];
    if (aside.saved) lines.push(`The learner saved this for a future session: ${aside.saved}`);
    return lines.join("\n");
  });
  return entries.length ? entries.join("\n\n") : null;
}
