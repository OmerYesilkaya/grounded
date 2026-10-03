import { type SourceKind } from "@grounded/core";
import { strFromU8, unzipSync } from "fflate";
import { Parser } from "htmlparser2";
import mammoth from "mammoth";
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";

/*
 * Taking the text out of a source (design §4.6), with no model: a PDF's text layer page by page,
 * with its bookmarks for chapters; an EPUB's chapters in reading order; a Word document's or a text
 * file's text, split at its headings. Pages whose text layer is missing or garbled are marked for
 * the learner's model to read (transcribe.ts).
 */

/** A PDF page: its text layer, and whether the model has to read it instead. */
export interface SourcePage {
  /** From 1. */
  page: number;
  /** The page's number as the book prints it, where the PDF says ("xii", "112"); else `page`. */
  label: string;
  text: string;
  needsModel: boolean;
}

/** A chapter the source names: a PDF bookmark at a page, or a heading in flowing text. */
export interface Chapter {
  title: string;
  /** A PDF chapter's first page. */
  page?: number;
  /** A flowing source's chapter text. */
  text?: string;
}

export type Extracted =
  | { form: "paged"; title: string | null; pages: SourcePage[]; chapters: Chapter[] }
  | { form: "flowing"; title: string | null; chapters: (Chapter & { text: string })[] };

/** Thrown when a file can't be opened as what it says it is. */
export class UnreadableSource extends Error {}

export async function extractSource(kind: SourceKind, bytes: Uint8Array): Promise<Extracted> {
  try {
    switch (kind) {
      case "pdf":
        return await extractPdf(bytes);
      case "epub":
        return extractEpub(bytes);
      case "docx":
        return await extractDocx(bytes);
      case "text":
        return extractText(bytes);
    }
  } catch (error) {
    if (error instanceof UnreadableSource) throw error;
    throw new UnreadableSource("the source could not be opened", { cause: error });
  }
}

/** Below this many letters a page has no text layer worth keeping. */
const THIN_PAGE = 80;
/** Above this share of unreadable characters a page's text layer is garbled. */
const GARBLED_SHARE = 0.05;

/** Whether a page's text layer can't be used as it is (scanned, or a font without its mapping). */
export function textLayerUnusable(text: string): boolean {
  const letters = text.replace(/\s/g, "");
  if (letters.length < THIN_PAGE) return true;
  // U+FFFD (a glyph pdf.js couldn't map), private-use glyphs and control characters.
  // eslint-disable-next-line no-control-regex
  const unreadable = letters.match(/[�-\u0000-\u0008\u000E-\u001F]/g)?.length ?? 0;
  return unreadable / letters.length > GARBLED_SHARE;
}

async function extractPdf(bytes: Uint8Array): Promise<Extracted> {
  // pdf.js takes the buffer over; it gets a copy so the caller's bytes stay whole.
  const pdf = await getDocumentProxy(bytes.slice());
  try {
    const { OPS } = await getResolvedPDFJS();
    const paints = new Set<number>([
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
      OPS.paintImageMaskXObject,
    ]);
    const labels = await pdf.getPageLabels().catch(() => null);
    const pages: SourcePage[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str;
        if (item.hasEOL) text += "\n";
        else if (item.str && !item.str.endsWith(" ")) text += " ";
      }
      text = tidy(text);
      let needsModel = false;
      if (textLayerUnusable(text)) {
        // A thin page is worth the model's reading only when there is something on it to read:
        // a scan is an image. A blank page, or one with a few words, is kept as it is.
        const operators = await page.getOperatorList();
        needsModel = operators.fnArray.some((fn) => paints.has(fn));
      }
      // An empty label is no label.
      const printed = labels?.[n - 1]?.trim();
      const label = printed === undefined || printed === "" ? String(n) : printed;
      pages.push({ page: n, label, text, needsModel });
      page.cleanup();
    }
    const chapters = await pdfChapters(pdf);
    const info = (await pdf.getMetadata().catch(() => null))?.info as { Title?: unknown } | null;
    const title = typeof info?.Title === "string" && info.Title.trim() ? info.Title.trim() : null;
    return { form: "paged", title, pages, chapters };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

/**
 * The PDF's chapters from its bookmarks: the top level, or the level below where the top holds
 * only a few entries (a book whose bookmarks are its parts). Each at the page it opens.
 */
async function pdfChapters(pdf: PdfDocument): Promise<Chapter[]> {
  const outline = (await pdf.getOutline().catch(() => null)) ?? [];
  const pageOf = async (dest: unknown): Promise<number | null> => {
    try {
      const resolved = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
      if (!Array.isArray(resolved) || resolved.length === 0) return null;
      const ref: unknown = resolved[0];
      if (typeof ref === "number") return ref + 1;
      return (await pdf.getPageIndex(ref as Parameters<PdfDocument["getPageIndex"]>[0])) + 1;
    } catch {
      return null;
    }
  };
  type Entry = (typeof outline)[number];
  const level = (entries: readonly Entry[]): readonly Entry[] => {
    const below = entries.flatMap((e): Entry[] => e.items as Entry[]);
    return entries.length < 4 && below.length > entries.length ? below : entries;
  };
  const chapters: Chapter[] = [];
  for (const entry of level(outline)) {
    const page = await pageOf(entry.dest);
    const title = entry.title.trim();
    if (page !== null && title) chapters.push({ title, page });
  }
  // In page order, one chapter per page (the last named wins).
  const byPage = new Map<number, Chapter>();
  for (const c of chapters.sort((a, b) => (a.page ?? 0) - (b.page ?? 0)))
    byPage.set(c.page ?? 0, c);
  return [...byPage.values()];
}

/** An EPUB's chapters, in its spine's reading order, each from its XHTML. */
function extractEpub(bytes: Uint8Array): Extracted {
  const files = unzipSync(bytes);
  const read = (path: string): string | null => {
    const file = files[path];
    return file ? strFromU8(file) : null;
  };
  const container = read("META-INF/container.xml");
  if (!container) throw new UnreadableSource("no container.xml");
  const opfPath = attributeOf(container, "rootfile", "full-path");
  const opf = opfPath ? read(opfPath) : null;
  if (!opfPath || !opf) throw new UnreadableSource("no package document");
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";

  const manifest = new Map<string, { href: string; type: string }>();
  const spine: string[] = [];
  let title: string | null = null;
  let inTitle = false;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const tag = name.toLowerCase();
        if (tag === "item" && attributes.id && attributes.href)
          manifest.set(attributes.id, {
            href: attributes.href,
            type: attributes["media-type"] ?? "",
          });
        if (tag === "itemref" && attributes.idref) spine.push(attributes.idref);
        if (tag === "dc:title" && title === null) inTitle = true;
      },
      ontext(text) {
        if (inTitle) title = (title ?? "") + text;
      },
      onclosetag(name) {
        if (name.toLowerCase() === "dc:title") inTitle = false;
      },
    },
    { xmlMode: true },
  );
  parser.end(opf);

  const chapters: (Chapter & { text: string })[] = [];
  for (const id of spine) {
    const item = manifest.get(id);
    if (!item?.type.includes("html")) continue;
    const path = decodeURIComponent(resolvePath(base, item.href.split("#")[0] ?? ""));
    const html = read(path);
    if (!html) continue;
    const { text, headings } = htmlToText(html);
    if (!text.trim()) continue;
    chapters.push({ title: headings[0] ?? "", text });
  }
  if (chapters.length === 0) throw new UnreadableSource("no chapters with text");
  const named = (title as string | null)?.trim();
  return { form: "flowing", title: named === undefined || named === "" ? null : named, chapters };
}

async function extractDocx(bytes: Uint8Array): Promise<Extracted> {
  const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
  return { form: "flowing", title: null, chapters: splitAtHeadings(htmlToText(value).text) };
}

function extractText(bytes: Uint8Array): Extracted {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new UnreadableSource("not UTF-8", { cause: error });
  }
  return { form: "flowing", title: null, chapters: splitAtHeadings(tidy(text)) };
}

/**
 * Markdown-like text split into chapters at its highest heading level that occurs more than once
 * (a document's single title heading doesn't make one chapter of the whole). Text before the first
 * heading is a chapter of its own, untitled.
 */
export function splitAtHeadings(text: string): (Chapter & { text: string })[] {
  const lines = text.split("\n");
  const levels = [1, 2, 3].map((depth) => ({
    depth,
    count: lines.filter((l) => headingDepth(l) === depth).length,
  }));
  const depth = levels.find((l) => l.count > 1)?.depth ?? null;
  if (depth === null) return text.trim() ? [{ title: "", text: text.trim() }] : [];
  const chapters: (Chapter & { text: string })[] = [];
  let current: { title: string; lines: string[] } = { title: "", lines: [] };
  const flush = () => {
    const body = current.lines.join("\n").trim();
    if (body) chapters.push({ title: current.title, text: body });
  };
  for (const line of lines) {
    const d = headingDepth(line);
    if (d !== null && d <= depth) {
      flush();
      current = { title: line.replace(/^#+\s*/, "").trim(), lines: [line] };
    } else current.lines.push(line);
  }
  flush();
  return chapters;
}

const headingDepth = (line: string): number | null => {
  const match = /^(#{1,6})\s+\S/.exec(line);
  return match ? (match[1]?.length ?? null) : null;
};

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "section",
  "article",
  "blockquote",
  "pre",
  "ul",
  "ol",
  "table",
  "tr",
  "figure",
  "figcaption",
  "dl",
  "dt",
  "dd",
]);
const SKIPPED_TAGS = new Set(["script", "style", "head", "title", "nav"]);

/**
 * HTML's text, with its headings as markdown headings, list items as "- " lines and table cells
 * set apart by " | ": enough structure for the tutor to read it and for chapters to be found.
 */
export function htmlToText(html: string): { text: string; headings: string[] } {
  let out = "";
  const headings: string[] = [];
  let skipping = 0;
  let heading: { depth: number; text: string } | null = null;
  const parser = new Parser(
    {
      onopentag(name) {
        const tag = name.toLowerCase();
        if (SKIPPED_TAGS.has(tag)) skipping++;
        if (skipping) return;
        const depth = /^h([1-6])$/.exec(tag)?.[1];
        if (depth) {
          heading = { depth: Number(depth), text: "" };
          out += "\n\n";
        } else if (BLOCK_TAGS.has(tag)) out += "\n\n";
        else if (tag === "li") out += "\n- ";
        else if (tag === "br") out += "\n";
        else if (tag === "td" || tag === "th") out += " | ";
      },
      ontext(text) {
        if (skipping) return;
        if (heading) heading.text += text;
        else out += text.replace(/\s+/g, " ");
      },
      onclosetag(name) {
        const tag = name.toLowerCase();
        if (SKIPPED_TAGS.has(tag)) skipping = Math.max(0, skipping - 1);
        if (skipping) return;
        if (heading && /^h[1-6]$/.test(tag)) {
          const text = heading.text.replace(/\s+/g, " ").trim();
          if (text) {
            out += `${"#".repeat(heading.depth)} ${text}\n\n`;
            headings.push(text);
          }
          heading = null;
        } else if (BLOCK_TAGS.has(tag)) out += "\n\n";
      },
    },
    { decodeEntities: true },
  );
  parser.end(html);
  return { text: tidy(out), headings };
}

/** Lines without trailing spaces, at most one blank line between paragraphs. */
export function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function attributeOf(xml: string, tag: string, attribute: string): string | null {
  let found: string | null = null;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (found === null && name.toLowerCase() === tag) found = attributes[attribute] ?? null;
      },
    },
    { xmlMode: true },
  );
  parser.end(xml);
  return found;
}

/** A path relative to a folder in the archive, with "../" and "./" resolved. */
function resolvePath(base: string, href: string): string {
  const parts = (base + href).split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") resolved.pop();
    else if (part !== "." && part !== "") resolved.push(part);
  }
  return resolved.join("/");
}
