import { pageRange } from "@grounded/core";
import type { Extracted, SourcePage } from "./extract.js";

/*
 * A source's chapters and passages (design §4.6). A chapter is what the learner is asked to read in
 * one go: the author's chapter; or, when that is too long for a sitting, a piece of it cut at the
 * book's own headings, or, where it has none, where the model finds the topic changes. A reader
 * stops where the author ends a topic, never where a prompt-sized cut lands. A passage is such a
 * cut: the prompt-sized pieces of a chapter's text that a probe or a lesson is given and a lesson
 * cites.
 */

/** The most text a passage holds: about 6,000 tokens, so a prompt can carry a chapter's worth. */
export const PASSAGE_MAX = 24_000;
/** A stretch shorter than this (a dedication, a one-page part title) joins its neighbour. */
export const PASSAGE_MIN = 1_500;
/** A chapter over this many pages is more than one sitting, and is cut at its own headings. */
export const LONG_CHAPTER_PAGES = 40;
/** The same for a source without pages, in characters. */
export const LONG_CHAPTER_CHARACTERS = 100_000;

export interface DraftPassage {
  /** A PDF's page the passage starts on, from 1. */
  pageStart: number | null;
  /** The pages as the book numbers them: "pp. 112–131". */
  pages: string | null;
  text: string;
}

export interface DraftChapter {
  title: string;
  part: string | null;
  pageStart: number | null;
  pages: string | null;
  /** The chapter's text, in characters. */
  characters: number;
  passages: DraftPassage[];
}

/** A unit a long chapter without headings is divided at: a page, or a paragraph. */
export interface DivisionUnit {
  /** "p. 112", or "¶ 12". */
  label: string;
  text: string;
}

/**
 * Divides a long chapter without headings where its topics change (divide.ts): the index of the
 * unit each piece starts at (the first piece starts at 0 whether or not it is named) and the
 * piece's title.
 */
export type Divider = (chapter: {
  title: string;
  units: readonly DivisionUnit[];
}) => Promise<{ at: number; title: string }[]>;

/** What a PDF's pages before its first bookmarked chapter are called (a preface, the contents). */
export const OPENING_PAGES = "Opening pages";

/** A PDF page's text in a passage: a line naming the page, so a lesson can cite it. */
const pageText = (page: SourcePage) => `[p. ${page.label}]\n${page.text}`;

/** A stretch of a source on its way to being a chapter: pages of a PDF, or flowing text. */
type Stretch = { title: string; part: string | null } & (
  | { form: "paged"; pages: SourcePage[]; headings: readonly { title: string; page: number }[] }
  | { form: "flowing"; text: string }
);

/**
 * The source's chapters, each with its passages. Without a divider (the survey's count), a long
 * chapter with no headings is left whole and its text counted in `undivided`, so the estimate can
 * allow for the calls that divide it.
 */
export async function toChapters(
  extracted: Extracted,
  divider: Divider | null,
): Promise<{ chapters: DraftChapter[]; undivided: number }> {
  let undivided = 0;
  const cut: Stretch[] = [];
  for (const stretch of stretches(extracted)) {
    if (!isLong(stretch)) {
      cut.push(stretch);
      continue;
    }
    const atHeadings = splitAtOwnHeadings(stretch);
    if (atHeadings.length > 1) {
      cut.push(...atHeadings);
      continue;
    }
    if (!divider) {
      undivided += length(stretch);
      cut.push(stretch);
      continue;
    }
    cut.push(...(await divide(stretch, divider)));
  }
  const chapters = merged(cut).map((stretch): DraftChapter => {
    const passages = passagesOf(stretch);
    const first = passages[0];
    const last = passages[passages.length - 1];
    return {
      title: stretch.title,
      part: stretch.part,
      pageStart: first?.pageStart ?? null,
      pages: first && last ? joinPages(first.pages, last.pages) : null,
      characters: passages.reduce((sum, p) => sum + p.text.length, 0),
      passages,
    };
  });
  return { chapters: chapters.filter((c) => c.passages.length > 0), undivided };
}

/** The author's chapters, as the source names them, each as a stretch of pages or text. */
function stretches(extracted: Extracted): Stretch[] {
  if (extracted.form === "flowing")
    return extracted.chapters.map((c) => ({
      form: "flowing",
      title: c.title,
      part: c.part,
      text: c.text,
    }));
  const { pages } = extracted;
  if (pages.length === 0) return [];
  // Chapter boundaries from the bookmarks; a stretch before the first is a chapter of its own.
  const starts = extracted.chapters
    .filter((c) => c.page !== undefined && c.page >= 1 && c.page <= pages.length)
    .map((c) => ({ ...c, page: c.page ?? 1 }));
  if (starts[0]?.page !== 1)
    starts.unshift({ title: OPENING_PAGES, part: null, page: 1, headings: [] });
  return starts.map((start, i) => {
    const end = (starts[i + 1]?.page ?? pages.length + 1) - 1;
    return {
      form: "paged",
      title: start.title,
      part: start.part,
      pages: pages.slice(start.page - 1, end),
      headings: (start.headings ?? []).filter((h) => h.page > start.page && h.page <= end),
    };
  });
}

const isLong = (stretch: Stretch) =>
  stretch.form === "paged"
    ? stretch.pages.length > LONG_CHAPTER_PAGES
    : stretch.text.length > LONG_CHAPTER_CHARACTERS;

/** A piece of a chapter cut at one of its headings: "Routing: Routing tables". */
const pieceTitle = (chapter: string, heading: string) =>
  heading.trim() ? `${chapter.trim() || "Untitled"}: ${heading.trim()}` : chapter;

/**
 * A long chapter cut at its own headings: a PDF's at the bookmarks under it, flowing text at the
 * heading level below its own that occurs more than once. The stretch before the first heading
 * keeps the chapter's title. One piece means there was nothing to cut at.
 */
function splitAtOwnHeadings(stretch: Stretch): Stretch[] {
  if (stretch.form === "paged") {
    const first = stretch.pages[0];
    if (!first || stretch.headings.length === 0) return [stretch];
    const starts = [
      { title: stretch.title, page: first.page },
      ...stretch.headings.map((h) => ({ title: pieceTitle(stretch.title, h.title), page: h.page })),
    ];
    return starts.flatMap((start, i): Stretch[] => {
      const end = starts[i + 1]?.page ?? first.page + stretch.pages.length;
      const pages = stretch.pages.filter((p) => p.page >= start.page && p.page < end);
      return pages.length
        ? [{ form: "paged", title: start.title, part: stretch.part, pages, headings: [] }]
        : [];
    });
  }
  const lines = stretch.text.split("\n");
  const own = headingDepth(lines[0] ?? "") ?? 0;
  const count = (depth: number) => lines.filter((l) => headingDepth(l) === depth).length;
  const depth = [1, 2, 3, 4, 5, 6].find((d) => d > own && count(d) > 1);
  if (depth === undefined) return [stretch];
  const pieces: Stretch[] = [];
  let current = { title: stretch.title, lines: [] as string[] };
  const flush = () => {
    const text = current.lines.join("\n").trim();
    if (text) pieces.push({ form: "flowing", title: current.title, part: stretch.part, text });
  };
  for (const line of lines) {
    if (headingDepth(line) === depth) {
      flush();
      current = { title: pieceTitle(stretch.title, line.replace(/^#+\s*/, "")), lines: [line] };
    } else current.lines.push(line);
  }
  flush();
  return pieces;
}

const headingDepth = (line: string): number | null => {
  const match = /^(#{1,6})\s+\S/.exec(line);
  return match ? (match[1]?.length ?? null) : null;
};

/**
 * The most of a chapter one dividing call reads (about 25,000 tokens, within a provider's
 * per-minute allowance on an ordinary key); a longer one is divided a window at a time.
 */
export const DIVIDE_WINDOW_CHARACTERS = 100_000;

/**
 * A long chapter with no headings, divided by the model where its topics change: a PDF's at page
 * boundaries, flowing text between paragraphs. A chapter longer than a call reads is divided a
 * window at a time, each window's first piece going on from the one before it.
 */
async function divide(stretch: Stretch, divider: Divider): Promise<Stretch[]> {
  const units: (DivisionUnit & { page?: SourcePage })[] =
    stretch.form === "paged"
      ? stretch.pages.map((page) => ({ label: `p. ${page.label}`, text: page.text, page }))
      : stretch.text
          .split(/\n\n/)
          .filter((p) => p.trim())
          .map((text, i) => ({ label: `¶ ${String(i + 1)}`, text }));
  const starts: { at: number; title: string }[] = [];
  let from = 0;
  while (from < units.length) {
    let to = from;
    let size = 0;
    while (
      to < units.length &&
      (to === from || size + (units[to]?.text.length ?? 0) <= DIVIDE_WINDOW_CHARACTERS)
    ) {
      size += units[to]?.text.length ?? 0;
      to++;
    }
    const window = units.slice(from, to);
    const cuts = await divider({ title: stretch.title, units: window });
    for (const cut of cuts)
      if (Number.isInteger(cut.at) && cut.at >= 0 && cut.at < window.length && cut.title.trim())
        starts.push({ at: from + cut.at, title: cut.title.trim() });
    from = to;
  }
  // Pieces start where the model said, each once, in order; the first starts at the beginning.
  const byStart = new Map<number, string>();
  for (const s of starts) if (!byStart.has(s.at)) byStart.set(s.at, s.title);
  const ordered = [...byStart].sort((a, b) => a[0] - b[0]);
  if (ordered[0]?.[0] !== 0) ordered.unshift([0, ""]);
  if (ordered.length < 2) return [stretch];
  return ordered.map(([at, title], i): Stretch => {
    const end = ordered[i + 1]?.[0] ?? units.length;
    const piece = units.slice(at, end);
    const named = pieceTitle(stretch.title, title);
    return stretch.form === "paged"
      ? {
          form: "paged",
          title: named,
          part: stretch.part,
          pages: piece.flatMap((u) => (u.page ? [u.page] : [])),
          headings: [],
        }
      : {
          form: "flowing",
          title: named,
          part: stretch.part,
          text: piece.map((u) => u.text).join("\n\n"),
        };
  });
}

const length = (stretch: Stretch) =>
  stretch.form === "paged"
    ? stretch.pages.reduce((sum, p) => sum + pageText(p).length, 0)
    : stretch.text.length;

/**
 * Stretches too short to stand alone joined to the one after them (the last to the one before), so
 * a part title page or a dedication doesn't become a chapter of its own. The joined chapter keeps
 * the longer one's title; a stretch can only join one of the same form.
 */
function merged(stretches: Stretch[]): Stretch[] {
  const out: Stretch[] = [];
  let carry: Stretch | null = null;
  for (const stretch of stretches) {
    const next: Stretch = carry ? (join(carry, stretch) ?? stretch) : stretch;
    if (carry && next === stretch) out.push(carry);
    carry = null;
    if (length(next) < PASSAGE_MIN) carry = next;
    else out.push(next);
  }
  if (carry) {
    const last = out.pop();
    const joined = last ? join(last, carry) : null;
    if (joined) out.push(joined);
    else {
      if (last) out.push(last);
      out.push(carry);
    }
  }
  return out;
}

/** Two stretches as one; null where they are of different forms. */
function join(a: Stretch, b: Stretch): Stretch | null {
  const title = length(a) >= length(b) ? a.title : b.title;
  const part = a.part ?? b.part;
  if (a.form === "paged" && b.form === "paged")
    return { form: "paged", title, part, pages: [...a.pages, ...b.pages], headings: [] };
  if (a.form === "flowing" && b.form === "flowing")
    return { form: "flowing", title, part, text: `${a.text}\n\n${b.text}` };
  return null;
}

/**
 * A chapter's passages: a PDF's pages grouped up to the most a passage holds, flowing text split
 * between paragraphs; a passage too short to stand alone joins its neighbour.
 */
function passagesOf(stretch: Stretch): DraftPassage[] {
  if (stretch.form === "flowing")
    return splitText(stretch.text, PASSAGE_MAX).map((text) => ({
      pageStart: null,
      pages: null,
      text,
    }));
  const groups: SourcePage[][] = [];
  let group: SourcePage[] = [];
  let size = 0;
  for (const page of stretch.pages) {
    const length = pageText(page).length;
    if (group.length && size + length > PASSAGE_MAX) {
      groups.push(group);
      group = [];
      size = 0;
    }
    group.push(page);
    size += length;
  }
  if (group.length) groups.push(group);
  const passages = groups.flatMap((pages): DraftPassage[] => {
    const first = pages[0];
    const last = pages[pages.length - 1];
    return first && last
      ? [
          {
            pageStart: first.page,
            pages: pageRange(first.label, last.label),
            text: pages.map(pageText).join("\n\n"),
          },
        ]
      : [];
  });
  return mergedPassages(passages);
}

function mergedPassages(passages: DraftPassage[]): DraftPassage[] {
  const out: DraftPassage[] = [];
  let carry: DraftPassage | null = null;
  const joinTwo = (a: DraftPassage, b: DraftPassage): DraftPassage => ({
    pageStart: a.pageStart ?? b.pageStart,
    pages: joinPages(a.pages, b.pages),
    text: `${a.text}\n\n${b.text}`,
  });
  for (const passage of passages) {
    const next: DraftPassage = carry ? joinTwo(carry, passage) : passage;
    carry = null;
    if (next.text.length < PASSAGE_MIN) carry = next;
    else out.push(next);
  }
  if (carry) {
    const last = out.pop();
    out.push(last ? joinTwo(last, carry) : carry);
  }
  return out.filter((p) => p.text.trim());
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

/** A paragraph longer than a passage, at line breaks or else at spaces. */
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

/** "pp. 1–2" and "pp. 3–9" as "pp. 1–9". */
export function joinPages(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return a ?? b;
  const first = /^pp?\. ([^–]+)/.exec(a)?.[1];
  const last = /([^– ]+)$/.exec(b)?.[1];
  return first && last ? pageRange(first, last) : a;
}
