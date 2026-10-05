import type { LanguageModelV4 } from "@ai-sdk/provider";
import { generateText, Output } from "ai";
import { z } from "zod";

/*
 * What each chapter of a source teaches, and what it expects its reader to know, in a sentence or
 * two each (design §4.6): the tutor's map of the source, which every call of the track carries in
 * place of the source itself, and what the learner is told before a chapter is assigned. And
 * whether the chapter is the book's text or its apparatus (a title page, the contents, an index),
 * which is never assigned as a reading: a category, not a judgment of worth. Written once, by the
 * cheap model, several chapters a call.
 */

/** The most chapter text one call reads: about 25,000 tokens. */
export const SUMMARY_BATCH_CHARACTERS = 100_000;

const SYSTEM =
  "You map a source a learner is reading chapter by chapter, for a tutor who assigns each chapter, asks the learner about it once they have read it, and teaches what they missed. The tutor sees your map in every call in place of the source, so it has to say what is where; and the learner is told what a chapter expects of them before they read it.";

const PROMPT = `For each chapter above, in the source's language, write two things. First, what it teaches: its main ideas and the terms it introduces, by name, in one or two plain sentences. Second, what it expects the reader to know already and doesn't explain, in one plain sentence, or an empty string if it assumes nothing beyond the chapters before it. No lists, no judgment of the source. Then say what kind of chapter it is: "apparatus" only if it is the book's apparatus rather than its text (a title or copyright page, publication information, a dedication, the table of contents, a list of figures or tables, an index, a bibliography or list of references, a glossary, acknowledgements, a note about the author); "text" for everything else, a preface, prelude or introduction included, since those are the author's own words. Give every chapter's number exactly as written.`;

/** What a chapter is: the book's text, or its apparatus, which is never assigned as a reading. */
export type ChapterKind = "text" | "apparatus";

const summariesSchema = z.object({
  summaries: z.array(
    z.object({
      n: z.number().int(),
      summary: z.string(),
      assumes: z.string(),
      kind: z.enum(["text", "apparatus"]),
    }),
  ),
});

export interface ChapterToSummarize {
  n: number;
  title: string;
  text: string;
}

export interface ChapterSummary {
  summary: string;
  assumes: string;
  kind: ChapterKind;
}

/** Chapters in groups whose text together stays within one call's reading. */
export function summaryBatches<T extends { text: string }>(
  chapters: readonly T[],
  limit = SUMMARY_BATCH_CHARACTERS,
): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const chapter of chapters) {
    if (current.length && size + chapter.text.length > limit) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(chapter);
    size += chapter.text.length;
  }
  if (current.length) out.push(current);
  return out;
}

/**
 * One batch's summaries, by chapter number; a chapter the reply leaves out is missing. A chapter
 * longer than a call reads is summarized from as much of it as fits, which says so.
 */
export async function summarizeChapters(
  model: LanguageModelV4,
  chapters: readonly ChapterToSummarize[],
  limit = SUMMARY_BATCH_CHARACTERS,
): Promise<Map<number, ChapterSummary>> {
  const body = chapters
    .map((c) => {
      const text =
        c.text.length <= limit
          ? c.text
          : `${c.text.slice(0, limit)}\n\n[The chapter goes on; the rest is left out here.]`;
      return `## Chapter ${String(c.n)}: ${c.title}\n\n${text}`;
    })
    .join("\n\n");
  const { output } = await generateText({
    model,
    system: SYSTEM,
    output: Output.object({ schema: summariesSchema }),
    prompt: `${body}\n\n---\n\n${PROMPT}`,
  });
  const wanted = new Set(chapters.map((c) => c.n));
  const found = new Map<number, ChapterSummary>();
  for (const { n, summary, assumes, kind } of output.summaries)
    if (wanted.has(n) && summary.trim())
      found.set(n, { summary: summary.trim(), assumes: assumes.trim(), kind });
  return found;
}
