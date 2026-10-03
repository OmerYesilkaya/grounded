import type { LanguageModelV4 } from "@ai-sdk/provider";
import { generateText } from "ai";
import { PDFDocument } from "pdf-lib";

/*
 * The pages of a source PDF whose text layer can't be used (a scan, a font without its mapping),
 * read by the learner's cheap model (design §4.6): a few pages at a time, copied into a PDF of
 * their own, so a call carries only what it reads.
 */

/** Pages per call: few enough that the reply stays well inside the cheap model's output. */
export const TRANSCRIBE_BATCH = 5;

const SYSTEM =
  "You transcribe pages of a source a learner is studying, for a tutor who will teach from it and cite it. Copy what the pages say, completely and exactly, in their own language; don't summarize, explain or correct.";

const request = (pages: readonly number[]) =>
  `This PDF holds pages ${pages.join(", ")} of the source, in that order. Transcribe each page in full as markdown: headings as headings, lists as lists, tables as markdown tables, formulas in LaTeX between $ and $ (or $$ and $$ on their own lines). Describe a figure, diagram or photo in one line in square brackets: [Figure: what it shows, with its caption]. Leave out running headers, footers and page numbers. Begin each page with a line of its own: === page N ===, with N the number given above. Reply with the transcription only.`;

const MARKER = /^=== page (\d+) ===\s*$/gm;

/** A transcription split back into its pages; a page the reply skipped is missing. */
export function splitTranscript(text: string): Map<number, string> {
  const pages = new Map<number, string>();
  const marks = [...text.matchAll(MARKER)];
  marks.forEach((mark, i) => {
    const start = mark.index + mark[0].length;
    const end = marks[i + 1]?.index ?? text.length;
    pages.set(Number(mark[1]), text.slice(start, end).trim());
  });
  return pages;
}

/** Consecutive runs of pages, each at most `size` long. */
export function batches(pages: readonly number[], size = TRANSCRIBE_BATCH): number[][] {
  const out: number[][] = [];
  for (const page of [...pages].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    const previous = last?.[last.length - 1];
    if (last && previous === page - 1 && last.length < size) last.push(page);
    else out.push([page]);
  }
  return out;
}

/** What stands for a page the model left out of its reply twice. */
export const UNREAD_PAGE = "[This page could not be read.]";

/**
 * Transcribes the pages, a batch at a time, handing each batch's pages to `onBatch` as it is read
 * (to keep them, and show progress). A page the reply leaves out is asked for again on its own,
 * once; then it stands as unread.
 */
export async function transcribePages(options: {
  pdf: Uint8Array;
  pages: readonly number[];
  model: () => Promise<LanguageModelV4>;
  onBatch: (read: Map<number, string>) => Promise<void>;
}): Promise<void> {
  const source = await PDFDocument.load(options.pdf, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const ask = async (pages: readonly number[]) => {
    const part = await PDFDocument.create();
    const copied = await part.copyPages(
      source,
      pages.map((p) => p - 1),
    );
    for (const page of copied) part.addPage(page);
    const { text } = await generateText({
      model: await options.model(),
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              data: await part.save(),
              mediaType: "application/pdf",
              filename: `pages-${pages.join("-")}.pdf`,
            },
            { type: "text", text: request(pages) },
          ],
        },
      ],
    });
    // A single page whose reply has no marker is that page.
    const split = splitTranscript(text);
    const only = pages[0];
    if (pages.length === 1 && only !== undefined && split.size === 0 && text.trim())
      split.set(only, text.trim());
    return split;
  };
  for (const batch of batches(options.pages)) {
    const read = await ask(batch);
    for (const page of batch.filter((p) => !read.get(p))) {
      const again = await ask([page]);
      const text = again.get(page);
      read.set(page, text === undefined || text === "" ? UNREAD_PAGE : text);
    }
    await options.onBatch(new Map(batch.map((p) => [p, read.get(p) ?? UNREAD_PAGE])));
  }
}
