import { ASIDE_LIMITS, type AsideAnchor } from "@grounded/core/aside-anchor";

/*
 * Passages of the lesson, for asides (design §7.5): what the learner selected, as an anchor the
 * server keeps (the block it starts in, the quote, a little text before and after it), and an
 * anchor found again as a range of the page. Both read the same text: the text of the lesson's
 * blocks (elements with `data-block`) inside a step's section (`data-step`), blocks separated by a
 * line break, so a passage never includes the page's own labels and buttons.
 */

interface Piece {
  node: Text;
  /** Where the node's text starts in the scope's text. */
  start: number;
}

interface ScopeText {
  text: string;
  pieces: Piece[];
}

/**
 * The lesson text of step `stepId` inside `scope`, and where each of its text nodes sits in it. A
 * check's thread and notes are in the step's section too, but they aren't the lesson's blocks
 * (theirs aren't the step's ids), and neither is maths' hidden copy for screen readers.
 */
function textOf(scope: Element, stepId: string): ScopeText {
  const walker = scope.ownerDocument.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const pieces: Piece[] = [];
  let text = "";
  let lastBlock: Element | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const block = node.parentElement?.closest("[data-block]") ?? null;
    if (
      !block ||
      !scope.contains(block) ||
      !block.getAttribute("data-block")?.startsWith(`${stepId}.`) ||
      node.parentElement?.closest(".katex-mathml") ||
      !(node instanceof Text) ||
      !node.data
    )
      continue;
    if (lastBlock && block !== lastBlock) text += "\n";
    lastBlock = block;
    pieces.push({ node, start: text.length });
    text += node.data;
  }
  return { text, pieces };
}

/** A selection made in the lesson, ready to ask about. */
export interface Selected {
  stepId: string;
  anchor: AsideAnchor;
  range: Range;
}

/**
 * The anchor of a selection inside one step of the lesson, or null when the selection isn't a
 * passage of it (it leaves the step, holds no lesson text, or is longer than a passage may be).
 */
export function anchorOf(lesson: Element, range: Range): Selected | null {
  if (range.collapsed) return null;
  const section = sectionOf(range.startContainer);
  if (!section || !lesson.contains(section) || sectionOf(range.endContainer) !== section)
    return null;
  const stepId = section.getAttribute("data-step");
  if (!stepId) return null;

  const { text, pieces } = textOf(section, stepId);
  let start = -1;
  let end = -1;
  let first: Piece | null = null;
  for (const piece of pieces) {
    if (!range.intersectsNode(piece.node)) continue;
    const from = piece.node === range.startContainer ? range.startOffset : 0;
    const to = piece.node === range.endContainer ? range.endOffset : piece.node.length;
    if (to <= from) continue;
    if (start === -1) {
      start = piece.start + from;
      first = piece;
    }
    end = piece.start + to;
  }
  if (start === -1 || !first) return null;
  // A passage starts and ends at its words.
  while (start < end && /\s/.test(text.charAt(start))) start++;
  while (end > start && /\s/.test(text.charAt(end - 1))) end--;
  const quote = text.slice(start, end);
  if (!quote || quote.length > ASIDE_LIMITS.quote) return null;
  const blockId = first.node.parentElement?.closest("[data-block]")?.getAttribute("data-block");
  if (!blockId) return null;
  const context = ASIDE_LIMITS.context;
  return {
    stepId,
    anchor: {
      blockId,
      quote,
      prefix: text.slice(Math.max(0, start - context), start),
      suffix: text.slice(end, end + context),
    },
    range: rangeOf({ text, pieces }, start, end, section.ownerDocument),
  };
}

/**
 * The passage an anchor names, found again: in its block first, else anywhere in its step (the block
 * may have changed). Where the quote appears more than once, the text around it picks one. Null when
 * the passage is gone.
 */
export function findPassage(lesson: Element, stepId: string, anchor: AsideAnchor): Range | null {
  const section = lesson.querySelector(`[data-step="${stepId}"]`);
  if (!section) return null;
  const block = section.querySelector(`[data-block="${anchor.blockId}"]`);
  for (const scope of block ? [block, section] : [section]) {
    const scopeText = textOf(scope, stepId);
    const at = bestMatch(scopeText.text, anchor);
    if (at !== -1) return rangeOf(scopeText, at, at + anchor.quote.length, section.ownerDocument);
  }
  return null;
}

/** The occurrence of the quote whose surroundings match the anchor's best; -1 when there is none. */
export function bestMatch(text: string, anchor: Pick<AsideAnchor, "quote" | "prefix" | "suffix">) {
  let best = -1;
  let bestScore = -1;
  for (let at = text.indexOf(anchor.quote); at !== -1; at = text.indexOf(anchor.quote, at + 1)) {
    const score =
      sharedEnd(text.slice(0, at), anchor.prefix) +
      sharedStart(text.slice(at + anchor.quote.length), anchor.suffix);
    if (score > bestScore) {
      best = at;
      bestScore = score;
    }
  }
  return best;
}

function sharedEnd(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function sharedStart(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function sectionOf(node: Node): Element | null {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest("[data-step]") ?? null;
}

/** A range over the scope's text from `start` to `end`. */
function rangeOf({ pieces }: ScopeText, start: number, end: number, document: Document): Range {
  const range = document.createRange();
  const at = (offset: number, edge: "start" | "end") => {
    // An offset on a line break between blocks belongs to the next block's text (or the last).
    const piece =
      pieces.find((p) =>
        edge === "start"
          ? offset < p.start + p.node.length
          : offset <= p.start + p.node.length && offset > p.start,
      ) ?? pieces.at(-1);
    if (!piece) return null;
    return {
      node: piece.node,
      offset: Math.max(0, Math.min(piece.node.length, offset - piece.start)),
    };
  };
  const from = at(start, "start");
  const to = at(end, "end");
  if (from) range.setStart(from.node, from.offset);
  if (to) range.setEnd(to.node, to.offset);
  return range;
}

const HIGHLIGHTS = ["aside", "aside-active"] as const;

/**
 * Marks passages with the CSS Custom Highlight API: no element is added to the lesson, so the
 * page's own rendering is untouched. Browsers without it show the cards without the marks.
 */
export function highlightPassages(ranges: { quiet: Range[]; active: Range[] }): () => void {
  if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined")
    return () => undefined;
  CSS.highlights.set("aside", new Highlight(...ranges.quiet));
  const active = new Highlight(...ranges.active);
  active.priority = 1;
  CSS.highlights.set("aside-active", active);
  return () => {
    for (const name of HIGHLIGHTS) CSS.highlights.delete(name);
  };
}

/** The text position under a point, where the browser can tell. */
export function pointAt(x: number, y: number): { node: Node; offset: number } | null {
  if (typeof document.caretPositionFromPoint === "function") {
    const position = document.caretPositionFromPoint(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }
  // Safari before 26 has only the older one.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  if (typeof document.caretRangeFromPoint === "function") {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const range = document.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}

/** The first line box of a range, where the browser lays it out (not in tests). */
export function firstLine(range: Range): DOMRect | null {
  if (typeof range.getClientRects !== "function") return null;
  return range.getClientRects()[0] ?? null;
}
