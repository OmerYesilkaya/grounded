import type { LanguageModelV4 } from "@ai-sdk/provider";
import { generateText, Output } from "ai";
import { z } from "zod";

/*
 * What each section of a source covers, in a sentence or two (design §4.6): the tutor's map of the
 * source, which every call of the track carries in place of the source itself. Written once, by the
 * cheap model, several sections a call.
 */

/** The most section text one call reads: about 25,000 tokens. */
export const SUMMARY_BATCH_CHARACTERS = 100_000;

const SYSTEM =
  "You map a source a learner is studying, for a tutor who will teach it to them section by section. The tutor sees your map in every call in place of the source, so it has to say what is where.";

const PROMPT = `For each section above, write one or two sentences, in the source's language: what it teaches (its main ideas, and the terms it introduces, by name), and what it expects the reader to know already that it doesn't explain. Plain sentences, no lists, no judgment of the source. Give every section's number exactly as written.`;

const summariesSchema = z.object({
  summaries: z.array(z.object({ n: z.number().int(), summary: z.string() })),
});

export interface SectionToSummarize {
  n: number;
  title: string;
  text: string;
}

/** Sections in groups whose text together stays within one call's reading. */
export function summaryBatches<T extends { text: string }>(
  sections: readonly T[],
  limit = SUMMARY_BATCH_CHARACTERS,
): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const section of sections) {
    if (current.length && size + section.text.length > limit) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(section);
    size += section.text.length;
  }
  if (current.length) out.push(current);
  return out;
}

/** One batch's summaries, by section number; a section the reply leaves out is missing. */
export async function summarizeSections(
  model: LanguageModelV4,
  sections: readonly SectionToSummarize[],
): Promise<Map<number, string>> {
  const body = sections
    .map((s) => `## Section ${String(s.n)}: ${s.title}\n\n${s.text}`)
    .join("\n\n");
  const { output } = await generateText({
    model,
    system: SYSTEM,
    output: Output.object({ schema: summariesSchema }),
    prompt: `${body}\n\n---\n\n${PROMPT}`,
  });
  const wanted = new Set(sections.map((s) => s.n));
  const found = new Map<number, string>();
  for (const { n, summary } of output.summaries)
    if (wanted.has(n) && summary.trim()) found.set(n, summary.trim());
  return found;
}
