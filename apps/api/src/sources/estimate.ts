import { estimateCost } from "@grounded/providers";

/*
 * What reading a source will cost on the learner's cheap model (design §4.6), shown before it
 * starts. Rough by design: the estimate errs high, so the reading costs no more than the learner
 * agreed to.
 */

/** A PDF page sent to the model: providers count a page as its image and its text, ~1,500–3,000. */
const PAGE_INPUT_TOKENS = 2_500;
/** A transcribed page's markdown. */
const PAGE_OUTPUT_TOKENS = 900;
/** What a transcribed page adds to the source's text, in characters. */
export const TRANSCRIBED_PAGE_CHARACTERS = 3_000;
/** The instructions around each call. */
const CALL_OVERHEAD_TOKENS = 300;
/** A chapter's summary and what it assumes. */
const SUMMARY_OUTPUT_TOKENS = 160;
/** A long chapter divided by the model: its text read once more, and a few titles written. */
const DIVISION_INPUT_CHARACTERS = 300_000;
const DIVISION_OUTPUT_TOKENS = 200;

export function readingEstimate(options: {
  modelId: string;
  /** Pages the model transcribes, in batches of `batch`. */
  transcribe: number;
  batch: number;
  /** The source's text once read, in characters, which the summaries read whole. */
  characters: number;
  chapters: number;
  /** Long chapters with no headings of their own, which the model divides into topics. */
  divide: number;
  summaryBatchCharacters: number;
}): number | null {
  const calls =
    Math.ceil(options.transcribe / options.batch) +
    Math.ceil(options.characters / options.summaryBatchCharacters) +
    options.divide;
  const inputTokens =
    options.transcribe * PAGE_INPUT_TOKENS +
    Math.ceil(options.characters / 4) +
    Math.ceil((options.divide * DIVISION_INPUT_CHARACTERS) / 4) +
    calls * CALL_OVERHEAD_TOKENS;
  const outputTokens =
    options.transcribe * PAGE_OUTPUT_TOKENS +
    options.chapters * SUMMARY_OUTPUT_TOKENS +
    options.divide * DIVISION_OUTPUT_TOKENS;
  return estimateCost(options.modelId, { inputTokens, cachedInputTokens: 0, outputTokens });
}
