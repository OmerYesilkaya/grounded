import {
  SOURCE_LIMITS,
  sourceKind,
  sourceProblem,
  sourcesProblem,
  type RefusalNotice,
  type SourceKind,
} from "@grounded/core";
import { PDFDocument } from "pdf-lib";
import { cleanName, type UploadedFile } from "./attachments.js";

/** A file accepted as a source (design §4.6): stored as it is, and read into sections by a job. */
export interface SourceUpload {
  name: string;
  kind: SourceKind;
  mediaType: string;
  bytes: Uint8Array;
  /** A PDF's page count. */
  pages: number | null;
}

export type SourcesResult =
  { ok: true; sources: SourceUpload[] } | { ok: false; error: RefusalNotice };

/**
 * Checks the sources as they arrive: the shared limits on names and sizes, then that each file is
 * what its name says (a PDF opens and isn't password-protected, an EPUB or Word document is an
 * archive, text is UTF-8), then the pages across the PDFs. What is inside is read later, by the
 * survey (engine/source-tasks.ts), which can take longer than a request should.
 */
export async function readSources(files: readonly UploadedFile[]): Promise<SourcesResult> {
  const together = sourcesProblem(files.map((f) => ({ size: f.bytes.length })));
  if (together) return { ok: false, error: together };
  const sources: SourceUpload[] = [];
  for (const file of files) {
    const name = cleanName(file.name);
    const problem = sourceProblem(name, file.bytes.length);
    if (problem) return { ok: false, error: problem };
    const read = await readOne(name, file.bytes);
    if ("code" in read) return { ok: false, error: read };
    sources.push(read);
  }
  const pages = sources.reduce((sum, s) => sum + (s.pages ?? 0), 0);
  if (pages > SOURCE_LIMITS.pdfPages)
    return {
      ok: false,
      error: { code: "attachments-pdf-pages", pages, max: SOURCE_LIMITS.pdfPages },
    };
  return { ok: true, sources };
}

async function readOne(name: string, bytes: Uint8Array): Promise<SourceUpload | RefusalNotice> {
  const accepted = sourceKind(name);
  if (!accepted) return { code: "source-kind", name };
  const base = { name, ...accepted, bytes, pages: null };
  const notWhatItSays: RefusalNotice = { code: "attachment-not-what-it-says", name };
  switch (accepted.kind) {
    case "pdf": {
      if (!startsWith(bytes, "%PDF-")) return notWhatItSays;
      try {
        const document = await PDFDocument.load(bytes, {
          ignoreEncryption: true,
          updateMetadata: false,
        });
        if (document.isEncrypted) return { code: "attachment-password", name };
        return { ...base, pages: document.getPageCount() };
      } catch {
        return { code: "attachment-unreadable", name, as: "pdf" };
      }
    }
    case "epub":
    case "docx":
      return startsWith(bytes, "PK\u0003\u0004") ? base : notWhatItSays;
    case "text":
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return { code: "attachment-not-utf8", name };
      }
      return base;
  }
}

function startsWith(bytes: Uint8Array, signature: string): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) if (bytes[i] !== signature.charCodeAt(i)) return false;
  return true;
}
