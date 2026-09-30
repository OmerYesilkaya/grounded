/*
 * Files a learner attaches to a new track (design §4.5), and what is accepted: shared by the web,
 * which checks as files are added, and the API, which checks again and decides.
 *
 * Images and PDFs go to the model as they are, so the limits follow what every provider takes in
 * one request: Anthropic's 5 MB per image, and PDFs with 100 pages at most in all (a track's PDFs
 * ride in the same calls, so they share a smaller allowance). Text files and Word documents go as
 * their text, capped so one file can't crowd out the lesson.
 */

import type { RefusalNotice } from "./notices.js";

export type AttachmentKind = "image" | "pdf" | "text" | "docx";

export const ATTACHMENT_LIMITS = {
  files: 8,
  imageBytes: 5 * 1024 * 1024,
  fileBytes: 10 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
  /** Across all of a track's PDFs. */
  pdfPages: 50,
  /** Per text file or Word document, after its text is taken out. */
  textCharacters: 50_000,
} as const;

const KINDS: Record<string, { kind: AttachmentKind; mediaType: string }> = {
  png: { kind: "image", mediaType: "image/png" },
  jpg: { kind: "image", mediaType: "image/jpeg" },
  jpeg: { kind: "image", mediaType: "image/jpeg" },
  webp: { kind: "image", mediaType: "image/webp" },
  gif: { kind: "image", mediaType: "image/gif" },
  pdf: { kind: "pdf", mediaType: "application/pdf" },
  txt: { kind: "text", mediaType: "text/plain" },
  md: { kind: "text", mediaType: "text/markdown" },
  markdown: { kind: "text", mediaType: "text/markdown" },
  docx: {
    kind: "docx",
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
};

/** For a file input's `accept`. */
export const ATTACHMENT_ACCEPT = Object.keys(KINDS)
  .map((extension) => `.${extension}`)
  .join(",");

/** What a file is, by its name's extension; null for a kind that isn't accepted. */
export function attachmentKind(name: string): { kind: AttachmentKind; mediaType: string } | null {
  const extension = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase();
  // Own keys only: "x.constructor" is not a kind.
  return extension && Object.hasOwn(KINDS, extension) ? (KINDS[extension] ?? null) : null;
}

const megabytes = (bytes: number) => Math.round(bytes / (1024 * 1024));

/**
 * The first reason a file can't be attached, from its name and size alone (the API also reads what
 * is inside); null when it can. A notice the web words (design §9.3).
 */
export function attachmentProblem(name: string, size: number): RefusalNotice | null {
  const kind = attachmentKind(name);
  if (!kind) return { code: "attachment-kind", name };
  if (size === 0) return { code: "attachment-empty", name };
  const limit = kind.kind === "image" ? ATTACHMENT_LIMITS.imageBytes : ATTACHMENT_LIMITS.fileBytes;
  if (size > limit) return { code: "attachment-too-large", name, megabytes: megabytes(limit) };
  return null;
}

/** The first reason a set of files can't go together; null when it can. */
export function attachmentsProblem(files: readonly { size: number }[]): RefusalNotice | null {
  if (files.length > ATTACHMENT_LIMITS.files)
    return { code: "attachments-too-many", max: ATTACHMENT_LIMITS.files };
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > ATTACHMENT_LIMITS.totalBytes)
    return { code: "attachments-too-large", megabytes: megabytes(ATTACHMENT_LIMITS.totalBytes) };
  return null;
}
