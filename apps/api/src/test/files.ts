import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";

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
