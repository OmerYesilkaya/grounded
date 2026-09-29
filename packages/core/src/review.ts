import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { Issue, TrackTerm } from "@grounded/content";
import { generateText, Output } from "ai";
import { z } from "zod";

/**
 * What the validators can't decide by matching (design §3.3), judged by the cheap model in
 * context: the everyday words that may be the method's machinery ("I assumed…", "a map"), and the
 * domain terms that aren't on the term list at all.
 */
export const wordingReviewSchema = z.object({
  flagged: z
    .array(
      z.object({
        word: z.string(),
        machinery: z
          .boolean()
          .describe(
            "True only if, where it stands, the word refers to the tutor's own bookkeeping (a list of terms, what the learner has 'confirmed', a 'map' of ideas, a 'phase' of the session); false for its everyday or domain sense.",
          ),
      }),
    )
    .describe("Each of the listed words, judged where it is used."),
  jargon: z
    .array(
      z.object({
        word: z.string().describe("As the text writes it."),
        plain: z.string().describe("What it means, in a few plain words the learner has."),
      }),
    )
    .describe(
      "Domain terms the text uses as if the learner knew them: jargon this learner wouldn't know, that they don't hold (below), that their own words don't show they know, and that the text doesn't explain right where it uses it. Not everyday words, names of people or places, or words in code or maths. Usually none.",
    ),
});

export type WordingReview = z.infer<typeof wordingReviewSchema>;

/** One piece of learner-facing text to review, and what the learner holds while reading it. */
export interface ReviewUnit {
  /** The text as the model wrote it. */
  markdown: string;
  /** The ambiguous words the validator found in it (issues with severity "review"). */
  flagged: readonly Issue[];
  terms: readonly TrackTerm[];
  /** Terms the surroundings teach before it, and the ones its own word cards give. */
  introduced?: readonly string[];
}

/**
 * What the learner has said about themselves and the subject, which the term list doesn't carry:
 * before the plan it is empty, and a word the learner uses daily is on it only once a plan puts it
 * there. A senior front-end developer asked about "React" knows it.
 */
export interface LearnerWords {
  /** What they wrote they want to learn, as typed. */
  goal: string;
  /** What they brought (their files), summarized; null without any. */
  brief: string | null;
  /** Their messages in this session, oldest first. */
  said: readonly string[];
}

/** Judges a unit; resolves to the issues that should be fixed (none when it reads fine). */
export type Reviewer = (unit: ReviewUnit) => Promise<Issue[]>;

const HELD = new Set(["confirmed", "assumed", "borrowed"]);

export const REVIEW_RULES = [
  "You check a tutor's text before a learner reads it. The tutor keeps private bookkeeping the learner must never see: a list of terms with statuses (planned, taught, confirmed, assumed), a map or graph of what rests on what (roots, nodes, edges, frontiers), and the session's phases. The same words have everyday and domain senses, which are fine.",
  "Judge each listed word where it stands. Then list any domain term the text uses that the learner doesn't hold and that isn't explained right there; most texts have none. Names in the learner's list count as held in any spelling or form.",
  "The learner's own words count too. A term they used themselves, or one the background they describe plainly covers, is held: a working web developer knows React, a nurse knows blood pressure. Explaining it to them tells them the tutor wasn't listening. Judge against this learner, not a newcomer.",
].join("\n\n");

/** The part of the review's prompt that holds while a session lasts: the rules and the terms. */
export function reviewSystem(terms: readonly TrackTerm[], introduced: readonly string[]): string {
  const held = [...terms.filter((t) => HELD.has(t.status)).map((t) => t.term), ...introduced];
  const notYet = terms.filter((t) => !HELD.has(t.status) && !introduced.includes(t.term));
  return [
    REVIEW_RULES,
    `Terms the learner holds: ${held.join(" · ") || "none yet"}`,
    `Terms of the subject the learner doesn't hold yet: ${notYet.map((t) => t.term).join(" · ") || "none"}`,
  ].join("\n\n");
}

/** The issues a review found, written to be fed back to the tutor as any validator's are. */
export function reviewIssues(review: WordingReview, flagged: readonly Issue[]): Issue[] {
  const byWord = new Map(flagged.map((i) => [i.word?.toLowerCase(), i]));
  return [
    // Only the words it was asked about: a word the validator didn't flag isn't machinery.
    ...review.flagged.flatMap((f): Issue[] => {
      const issue = byWord.get(f.word.toLowerCase());
      if (!f.machinery || !issue) return [];
      return [
        {
          code: "scaffolding/judged",
          message: `"${f.word}" reads as the tutor's own bookkeeping here; the learner never sees it. Say what a tutor would say instead.`,
          ...(issue.blockId ? { blockId: issue.blockId } : {}),
        },
      ];
    }),
    ...review.jargon.map((j): Issue => ({
      code: "term/judged",
      message: `"${j.word}" is used as if the learner knew it, and they don't; say it in plain words (${j.plain}), or explain it right where it is used.`,
    })),
  ];
}

/**
 * Below this many words, a text with no word to judge isn't reviewed: a verdict's "That's it." or
 * a one-line question has no room for hidden jargon, and a learner is waiting on it.
 */
export const REVIEW_MIN_WORDS = 25;

function needsReview(markdown: string, words: readonly string[]): boolean {
  return words.length > 0 || markdown.split(/\s+/).filter(Boolean).length >= REVIEW_MIN_WORDS;
}

/** The learner's words, as the review's prompt carries them (the newest, if there are many). */
export const LEARNER_WORDS_LIMIT = 6_000;

export function learnerWords(learner: LearnerWords): string {
  const said: string[] = [];
  let room = LEARNER_WORDS_LIMIT - learner.goal.length - (learner.brief?.length ?? 0);
  for (const message of [...learner.said].reverse()) {
    if (message.length > room) break;
    said.unshift(message);
    room -= message.length;
  }
  return [
    `What the learner wrote they want to learn: ${learner.goal}`,
    ...(learner.brief ? [`What they brought, summarized: ${learner.brief}`] : []),
    said.length
      ? `What they have said this session:\n${said.map((m) => `- ${m}`).join("\n")}`
      : "They have said nothing else this session.",
  ].join("\n\n");
}

/** A Reviewer on a model: one structured call per unit, at the cheap model's pace. */
export async function reviewWording(
  model: LanguageModelV4,
  unit: ReviewUnit,
  learner?: LearnerWords,
): Promise<Issue[]> {
  const words = [...new Set(unit.flagged.flatMap((i) => (i.word ? [i.word] : [])))];
  if (!needsReview(unit.markdown, words)) return [];
  const { output } = await generateText({
    model,
    system: reviewSystem(unit.terms, unit.introduced ?? []),
    output: Output.object({ schema: wordingReviewSchema }),
    prompt: [
      ...(learner ? [learnerWords(learner)] : []),
      words.length
        ? `Words to judge: ${words.map((w) => `"${w}"`).join(", ")}`
        : "No words to judge.",
      "The text:",
      unit.markdown,
    ].join("\n\n"),
  });
  return reviewIssues(output, unit.flagged);
}
