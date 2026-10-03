/*
 * A track taught from a source the learner brings (design §4.6): a book, a long PDF, an EPUB, a
 * Word document or a text file. What is accepted is shared by the web, which checks as files are
 * added, and the API, which checks again and decides.
 *
 * A source is never sent to the model whole: it is read once into sections, and each call carries
 * the sections it needs. So the limits are about what one request can carry to the server and what
 * a track can sensibly hold, not about what a provider takes in one call.
 */

import type { RefusalNotice, SourceFailure } from "./notices.js";

export type SourceKind = "pdf" | "epub" | "docx" | "text";

export const SOURCE_LIMITS = {
  files: 5,
  fileBytes: 100 * 1024 * 1024,
  /** The request carries every source at once, so this bounds what the server holds in memory. */
  totalBytes: 100 * 1024 * 1024,
  /** Across all of a track's PDFs: a long textbook is 1,500. */
  pdfPages: 3000,
  /** Across all the sources, once read: about 1.5 million tokens, a shelf of long books. */
  characters: 6_000_000,
} as const;

const KINDS: Record<string, { kind: SourceKind; mediaType: string }> = {
  pdf: { kind: "pdf", mediaType: "application/pdf" },
  epub: { kind: "epub", mediaType: "application/epub+zip" },
  docx: {
    kind: "docx",
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  txt: { kind: "text", mediaType: "text/plain" },
  md: { kind: "text", mediaType: "text/markdown" },
  markdown: { kind: "text", mediaType: "text/markdown" },
};

/** For a file input's `accept`. */
export const SOURCE_ACCEPT = Object.keys(KINDS)
  .map((extension) => `.${extension}`)
  .join(",");

/** What a source is, by its name's extension; null for a kind that isn't accepted. */
export function sourceKind(name: string): { kind: SourceKind; mediaType: string } | null {
  const extension = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase();
  return extension && Object.hasOwn(KINDS, extension) ? (KINDS[extension] ?? null) : null;
}

const megabytes = (bytes: number) => Math.round(bytes / (1024 * 1024));

/** The first reason a file can't be a source, from its name and size alone; null when it can. */
export function sourceProblem(name: string, size: number): RefusalNotice | null {
  if (!sourceKind(name)) return { code: "source-kind", name };
  if (size === 0) return { code: "attachment-empty", name };
  if (size > SOURCE_LIMITS.fileBytes)
    return { code: "attachment-too-large", name, megabytes: megabytes(SOURCE_LIMITS.fileBytes) };
  return null;
}

/** The first reason a set of sources can't go together; null when it can. */
export function sourcesProblem(files: readonly { size: number }[]): RefusalNotice | null {
  if (files.length === 0) return { code: "source-required" };
  if (files.length > SOURCE_LIMITS.files)
    return { code: "attachments-too-many", max: SOURCE_LIMITS.files };
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > SOURCE_LIMITS.totalBytes)
    return { code: "attachments-too-large", megabytes: megabytes(SOURCE_LIMITS.totalBytes) };
  return null;
}

/**
 * Where reading a track's sources stands (design §4.6). `surveying`: the text is being taken out
 * and the pages that need the model counted. `awaiting`: the estimate is ready and the learner
 * hasn't said to read yet. `reading`: the model is reading (transcribing pages, then summarizing
 * sections). `ready`: the track can be taught. `failed`: reading stopped; `failure` says why.
 */
export type SourceStatus = "surveying" | "awaiting" | "reading" | "ready" | "failed";

export interface SourceReading {
  status: SourceStatus;
  /** Pages (or, for a source without pages, sections) in all the sources. */
  pages: number;
  /** Pages with no usable text layer, which the learner's model transcribes. */
  transcribe: number;
  /** Of those, how many are read so far. */
  transcribed: number;
  /** Sections the reading made, and how many are summarized so far. */
  sections: number;
  summarized: number;
  /** The estimated cost of reading, in USD; null when the model's price isn't known. */
  estimate: number | null;
  /** Why reading stopped, while `failed`. */
  failure: SourceFailure | null;
}

/** A section of a track's sources, as the browser shows it in the coverage view. */
export interface SourceSectionView {
  /** The section's number across the track's sources, from 1: what the tutor calls it ("§12"). */
  n: number;
  source: string;
  title: string;
  /** "pp. 112–131", or null for a source without pages. */
  pages: string | null;
  /**
   * taught: a lesson taught from it · known: the plan found the learner already holds it ·
   * planned: an arc of the plan covers it · ahead: no arc covers it yet.
   */
  status: "taught" | "known" | "planned" | "ahead";
}

/** A page range as a reader writes it, from the pages' printed numbers: "p. 12", "pp. xi–31". */
export function pageRange(start: string, end: string): string {
  return end === start ? `p. ${start}` : `pp. ${start}–${end}`;
}
