import type { LanguageModelV4 } from "@ai-sdk/provider";
import { generateText, Output } from "ai";
import { z } from "zod";
import type { DivisionUnit } from "./chapters.js";

/*
 * Dividing a long chapter that has no headings of its own into topics (design §4.6), once, by the
 * cheap model: the pieces a reader is asked to read one at a time, cut where the chapter's topic
 * changes, each with a title. A page of a PDF, or a paragraph of flowing text, is the unit a cut
 * can land on.
 */

const SYSTEM =
  "You divide a long chapter of a source a learner is studying into topics they can read one at a time, for a tutor who assigns the reading and then asks about it. The divisions are the chapter's own: cut where its topic changes, as its author would have put a heading, never at an even number of pages.";

const PROMPT = `The chapter above is given in units, each headed by its label (a page or a paragraph number), with the first unit at index 0. Divide it into topics a reader can take in one sitting: about 10 to 40 pages, or a few thousand words, each; fewer pieces where the chapter stays on one topic. For each piece give the index of the unit it starts at and a short title in the source's language, as its author might have headed it. The first piece starts at index 0. Give the pieces in order.`;

const divisionSchema = z.object({
  pieces: z.array(z.object({ at: z.number().int(), title: z.string() })),
});

/** One chapter's division, from the model: where each piece starts, and its title. */
export async function divideChapter(
  model: LanguageModelV4,
  chapter: { title: string; units: readonly DivisionUnit[] },
): Promise<{ at: number; title: string }[]> {
  const body = chapter.units
    .map((u, i) => `## [${String(i)}] ${u.label}\n\n${u.text}`)
    .join("\n\n");
  const { output } = await generateText({
    model,
    system: SYSTEM,
    output: Output.object({ schema: divisionSchema }),
    prompt: `# ${chapter.title || "Untitled chapter"}\n\n${body}\n\n---\n\n${PROMPT}`,
  });
  return output.pieces;
}
