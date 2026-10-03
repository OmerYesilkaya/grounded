import { pageRange } from "@grounded/core";
import type { Chapter, Extracted, SourcePage } from "./extract.js";

/*
 * A source's sections (design §4.6): its chapters, each a unit the plan can map an arc to and a
 * lesson can carry whole. A chapter too long for a lesson to carry is split into parts at page or
 * paragraph boundaries; a stretch too short to stand alone joins the section after it.
 */

/** The most text a section holds: about 6,000 tokens, so a lesson can carry two or three. */
export const SECTION_MAX = 24_000;
/** A section shorter than this (a dedication, a one-page part title) joins its neighbour. */
export const SECTION_MIN = 1_500;

export interface DraftSection {
  title: string;
  /** A PDF's page the section starts on, from 1. */
  pageStart: number | null;
  /** The pages as the book numbers them: "pp. 112–131". */
  pages: string | null;
  text: string;
}

/** What a PDF's pages before its first bookmarked chapter are called (a preface, the contents). */
export const OPENING_PAGES = "Opening pages";

/** A PDF page's text in a section: a line naming the page, so a lesson can cite it. */
const pageText = (page: SourcePage) => `[p. ${page.label}]\n${page.text}`;

export function toSections(extracted: Extracted): DraftSection[] {
  const drafts = extracted.form === "paged" ? pagedSections(extracted) : flowingSections(extracted);
  return merged(drafts);
}

function pagedSections(source: { pages: SourcePage[]; chapters: Chapter[] }): DraftSection[] {
  const { pages } = source;
  if (pages.length === 0) return [];
  // Chapter boundaries from the bookmarks; a stretch before the first is a section of its own.
  const starts = source.chapters
    .filter((c) => c.page !== undefined && c.page >= 1 && c.page <= pages.length)
    .map((c) => ({ title: c.title, page: c.page ?? 1 }));
  if (starts[0]?.page !== 1) starts.unshift({ title: OPENING_PAGES, page: 1 });
  const sections: DraftSection[] = [];
  starts.forEach((start, i) => {
    const end = (starts[i + 1]?.page ?? pages.length + 1) - 1;
    const chapter = pages.slice(start.page - 1, end);
    // Split at page boundaries, each part as close to the most a section holds as whole pages go.
    const parts: SourcePage[][] = [];
    let part: SourcePage[] = [];
    let size = 0;
    for (const page of chapter) {
      const length = pageText(page).length;
      if (part.length && size + length > SECTION_MAX) {
        parts.push(part);
        part = [];
        size = 0;
      }
      part.push(page);
      size += length;
    }
    if (part.length) parts.push(part);
    parts.forEach((p, k) => {
      const first = p[0];
      const last = p[p.length - 1];
      if (!first || !last) return;
      sections.push({
        title: partTitle(start.title, k, parts.length),
        pageStart: first.page,
        pages: pageRange(first.label, last.label),
        text: p.map(pageText).join("\n\n"),
      });
    });
  });
  return sections;
}

function flowingSections(source: { chapters: (Chapter & { text: string })[] }): DraftSection[] {
  return source.chapters.flatMap((chapter) => {
    const parts = splitText(chapter.text, SECTION_MAX);
    return parts.map((text, k) => ({
      title: partTitle(chapter.title, k, parts.length),
      pageStart: null,
      pages: null,
      text,
    }));
  });
}

/** Text in parts of at most `max` characters, split between paragraphs (or, failing that, lines). */
export function splitText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n\n/)) {
    const pieces = paragraph.length > max ? hardSplit(paragraph, max) : [paragraph];
    for (const piece of pieces) {
      if (current && current.length + piece.length + 2 > max) {
        parts.push(current);
        current = "";
      }
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** A paragraph longer than a section, at line breaks or else at spaces. */
function hardSplit(paragraph: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = paragraph;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const at = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const cut = at > max / 2 ? at : max;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

function partTitle(title: string, index: number, of: number): string {
  const name = title.trim() || "Untitled";
  return of > 1 ? `${name} (part ${String(index + 1)} of ${String(of)})` : name;
}

/**
 * Sections too short to stand alone joined to the one after them (the last to the one before), so
 * a part title page or a dedication doesn't become a section of its own. The joined section keeps
 * the longer one's title.
 */
function merged(sections: DraftSection[]): DraftSection[] {
  const out: DraftSection[] = [];
  let carry: DraftSection | null = null;
  for (const section of sections) {
    const next: DraftSection = carry ? join(carry, section) : section;
    carry = null;
    if (next.text.length < SECTION_MIN) carry = next;
    else out.push(next);
  }
  if (carry) {
    const last = out.pop();
    out.push(last ? join(last, carry) : carry);
  }
  return out.filter((s) => s.text.trim());
}

function join(a: DraftSection, b: DraftSection): DraftSection {
  const title = a.text.length >= b.text.length ? a.title : b.title;
  return {
    title,
    pageStart: a.pageStart ?? b.pageStart,
    pages: joinPages(a.pages, b.pages),
    text: `${a.text}\n\n${b.text}`,
  };
}

/** "pp. 1–2" and "pp. 3–9" as "pp. 1–9". */
function joinPages(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return a ?? b;
  const first = /^pp?\. ([^–]+)/.exec(a)?.[1];
  const last = /([^– ]+)$/.exec(b)?.[1];
  return first && last ? pageRange(first, last) : a;
}
