import {
  ATTACHMENT_LIMITS,
  attachmentKind,
  attachmentProblem,
  attachmentsProblem,
  isNotice,
  type AttachmentKind,
  type RefusalNotice,
} from "@grounded/core";
import mammoth from "mammoth";
import { PDFDocument } from "pdf-lib";

/** A file as the learner sent it. */
export interface UploadedFile {
  name: string;
  bytes: Uint8Array;
}

/** A file that may be attached, with what the model will read of it. */
export interface Attachment {
  name: string;
  kind: AttachmentKind;
  /** From the file's contents for images, so a JPEG named .png is sent as a JPEG. */
  mediaType: string;
  bytes: Uint8Array;
  /** A PDF's page count. */
  pages: number | null;
  /** Text files and Word documents: the text the model reads in place of the file. */
  text: string | null;
}

export type AttachmentsResult =
  { ok: true; attachments: Attachment[] } | { ok: false; error: RefusalNotice };

/**
 * Checks the files (design §4.5): the shared limits on names and sizes, then what is inside each
 * (a file is what its contents say, not its name), then the limits across them.
 */
export async function readAttachments(files: readonly UploadedFile[]): Promise<AttachmentsResult> {
  const together = attachmentsProblem(files.map((f) => ({ size: f.bytes.length })));
  if (together) return { ok: false, error: together };
  const attachments: Attachment[] = [];
  for (const file of files) {
    const name = cleanName(file.name);
    const problem = attachmentProblem(name, file.bytes.length);
    if (problem) return { ok: false, error: problem };
    const read = await readOne(name, file.bytes);
    if (isNotice(read)) return { ok: false, error: read };
    attachments.push(read);
  }
  const pages = attachments.reduce((sum, a) => sum + (a.pages ?? 0), 0);
  if (pages > ATTACHMENT_LIMITS.pdfPages)
    return {
      ok: false,
      error: { code: "attachments-pdf-pages", pages, max: ATTACHMENT_LIMITS.pdfPages },
    };
  return { ok: true, attachments };
}

/** The file's own name without any folders, control characters or runaway length. */
export function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const base = (name.split(/[/\\]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (base.length <= 200) return base || "file";
  const extension = /\.[^.]{1,10}$/.exec(base)?.[0] ?? "";
  return base.slice(0, 200 - extension.length) + extension;
}

async function readOne(name: string, bytes: Uint8Array): Promise<Attachment | RefusalNotice> {
  const accepted = attachmentKind(name);
  if (!accepted) return { code: "attachment-kind", name };
  const base = { name, kind: accepted.kind, bytes, pages: null, text: null };
  const notWhatItSays: RefusalNotice = { code: "attachment-not-what-it-says", name };
  switch (accepted.kind) {
    case "image": {
      const mediaType = imageType(bytes);
      return mediaType ? { ...base, mediaType } : notWhatItSays;
    }
    case "pdf": {
      if (!startsWith(bytes, "%PDF-")) return notWhatItSays;
      try {
        const document = await PDFDocument.load(bytes, {
          ignoreEncryption: true,
          updateMetadata: false,
        });
        if (document.isEncrypted) return { code: "attachment-password", name };
        return { ...base, mediaType: accepted.mediaType, pages: document.getPageCount() };
      } catch {
        return { code: "attachment-unreadable", name, as: "pdf" };
      }
    }
    case "text": {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); // a leading BOM is dropped
      } catch {
        return { code: "attachment-not-utf8", name };
      }
      return withText(base, accepted.mediaType, text);
    }
    case "docx": {
      if (!startsWith(bytes, "PK\u0003\u0004")) return notWhatItSays;
      try {
        const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
        return withText(base, accepted.mediaType, value);
      } catch {
        return { code: "attachment-unreadable", name, as: "docx" };
      }
    }
  }
}

function withText(
  base: Omit<Attachment, "mediaType" | "text">,
  mediaType: string,
  raw: string,
): Attachment | RefusalNotice {
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return { code: "attachment-no-text", name: base.name };
  if (text.length > ATTACHMENT_LIMITS.textCharacters)
    return {
      code: "attachment-too-long",
      name: base.name,
      characters: text.length,
      max: ATTACHMENT_LIMITS.textCharacters,
    };
  return { ...base, mediaType, text };
}

function startsWith(bytes: Uint8Array, signature: string, at = 0): boolean {
  if (bytes.length < at + signature.length) return false;
  for (let i = 0; i < signature.length; i++)
    if (bytes[at + i] !== signature.charCodeAt(i)) return false;
  return true;
}

/** An image's media type from its first bytes (PNG, JPEG, GIF, WebP); null for anything else. */
export function imageType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, "\u0089PNG\r\n\u001a\n")) return "image/png";
  if (startsWith(bytes, "ÿØÿ")) return "image/jpeg";
  if (startsWith(bytes, "GIF87a") || startsWith(bytes, "GIF89a")) return "image/gif";
  if (startsWith(bytes, "RIFF") && startsWith(bytes, "WEBP", 8)) return "image/webp";
  return null;
}
