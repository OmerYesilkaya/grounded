import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { PDFDocument, PDFHexString, PDFName, StandardFonts, type PDFRef } from "pdf-lib";

/** Real files of each kind a learner can attach, small enough for tests. */

/** A 1×1 PNG. */
export const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** A PDF with this many blank pages. */
export async function pdf(pages = 1): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  for (let i = 0; i < pages; i++) document.addPage();
  return document.save();
}

/** A Word document: "Ada Lovelace" and "Backend engineer: Node.js, Postgres, Redis caching." */
export const DOCX = new Uint8Array(readFileSync(new URL("./fixtures/cv.docx", import.meta.url)));

export const text = (value: string) => new TextEncoder().encode(value);

/** Lines enough to fill a page's text layer: `n` numbered sentences about `topic`. */
export const prose = (topic: string, n = 12) =>
  Array.from(
    { length: n },
    (_, i) => `Sentence ${String(i + 1)} about ${topic}, written out at a reasonable length.`,
  ).join("\n");

/**
 * A book as a PDF (a source, design §4.6): each page its lines of text (a text layer), or "scan"
 * for a page that is only a picture; with bookmarks for its chapters, each at a page from 1.
 */
export async function bookPdf(options: {
  pages: readonly string[];
  chapters?: readonly { title: string; page: number }[];
  title?: string;
}): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  if (options.title) document.setTitle(options.title);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const picture = await document.embedPng(PNG);
  for (const content of options.pages) {
    const page = document.addPage([600, 800]);
    if (content === "scan") {
      page.drawImage(picture, { x: 50, y: 50, width: 500, height: 700 });
      continue;
    }
    content.split("\n").forEach((line, i) => {
      page.drawText(line, { x: 40, y: 760 - i * 14, size: 10, font });
    });
  }
  const chapters = options.chapters ?? [];
  if (chapters.length) {
    const { context } = document;
    const outlines = context.nextRef();
    const items: PDFRef[] = chapters.map(() => context.nextRef());
    chapters.forEach((chapter, i) => {
      const item = context.obj({
        Title: PDFHexString.fromText(chapter.title),
        Parent: outlines,
        Dest: [document.getPage(chapter.page - 1).ref, PDFName.of("Fit")],
      });
      const previous = items[i - 1];
      const next = items[i + 1];
      if (previous) item.set(PDFName.of("Prev"), previous);
      if (next) item.set(PDFName.of("Next"), next);
      const ref = items[i];
      if (ref) context.assign(ref, item);
    });
    const first = items[0];
    const last = items[items.length - 1];
    if (first && last)
      context.assign(
        outlines,
        context.obj({ Type: "Outlines", First: first, Last: last, Count: chapters.length }),
      );
    document.catalog.set(PDFName.of("Outlines"), outlines);
  }
  return document.save();
}

/** An EPUB with these chapters in this reading order, each an XHTML page under its heading. */
export function epub(title: string, chapters: readonly { title: string; body: string }[]) {
  const manifest = chapters
    .map(
      (_, i) =>
        `<item id="c${String(i)}" href="text/c${String(i)}.xhtml" media-type="application/xhtml+xml"/>`,
    )
    .join("");
  const spine = chapters.map((_, i) => `<itemref idref="c${String(i)}"/>`).join("");
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    ),
    "OEBPS/content.opf": strToU8(
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`,
    ),
  };
  chapters.forEach((chapter, i) => {
    const paragraphs = chapter.body
      .split("\n\n")
      .map((p) => `<p>${p}</p>`)
      .join("");
    files[`OEBPS/text/c${String(i)}.xhtml`] = strToU8(
      `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><h1>${chapter.title}</h1>${paragraphs}</body></html>`,
    );
  });
  return zipSync(files);
}
