import type { Block, BlockType, DiagramFrame, Inline, Issue, LessonStep } from "./types.js";
import { cardNames } from "./word-cards.js";

/** Where content is shown. Each surface allows its own block types. */
export type Surface = "chat" | "lesson" | "aside" | "repair" | "review" | "homework";

const TEXT: BlockType[] = ["paragraph", "list", "quote", "code", "math", "table"];
const WITH_DRAWINGS: BlockType[] = [...TEXT, "diagram", "stepper"];

/**
 * The method's rules as allowlists: the probe and plan chat teaches nothing, so it carries text only;
 * checks exist only inside lessons.
 */
export const ALLOWED_BLOCKS: Record<Surface, readonly BlockType[]> = {
  chat: TEXT,
  lesson: [
    ...WITH_DRAWINGS,
    "heading",
    "divider",
    "chart",
    "check",
    "word",
    "about",
    "image",
    "video",
    "audio",
    "link",
  ],
  aside: [...WITH_DRAWINGS, "about"],
  repair: WITH_DRAWINGS,
  review: WITH_DRAWINGS,
  homework: [...TEXT, "heading", "divider", "diagram", "image", "video", "audio", "link"],
};

export type TermStatus = "planned" | "taught" | "confirmed" | "assumed" | "borrowed";

export interface TrackTerm {
  term: string;
  status: TermStatus;
}

const USABLE: readonly TermStatus[] = ["confirmed", "assumed", "borrowed"];

export interface ValidateContext {
  surface: Surface;
  terms?: readonly TrackTerm[];
  /** Domain jargon of the track (from research) that isn't in the plan: never usable untaught. */
  glossary?: readonly string[];
  /** Terms the surroundings introduced before this content (a lesson's earlier steps), usable here. */
  introduced?: readonly string[];
  /**
   * Terms this content teaches with word cards (a lesson step's new names): each needs its card,
   * and is usable only from it on.
   */
  taughtHere?: readonly string[];
}

/** Always the method's machinery when they appear in learner-facing text. */
const MACHINERY = [
  /\bledger\b/gi,
  /\bterm list\b/gi,
  /\bterms earned\b/gi,
  /\bnode closed\b/gi,
  /\bhangs off\b/gi,
  /\bforced by\b/gi,
  /\bphase \d+\b/gi,
  /\b(?:node|root) \d+\b/gi,
];

/** Everyday words that also name the machinery; a reviewer decides from context. */
const MAYBE_MACHINERY =
  /\b(?:roots?|nodes?|edges?|graphs?|maps?|sinks?|frontiers?|derived|confirmed|taught|assumed|planned|phases?)\b/gi;

export function validate(blocks: readonly Block[], context: ValidateContext): Issue[] {
  const issues: Issue[] = [];
  const allowed = ALLOWED_BLOCKS[context.surface];
  const terms = context.terms ?? [];
  const usable = new Set(
    [
      ...terms.filter((t) => USABLE.includes(t.status)).map((t) => t.term),
      ...(context.introduced ?? []),
    ].map(normalize),
  );
  // Taught here: untaught until its word card, usable from the card on (its definition included).
  const pending = (context.taughtHere ?? []).filter((term) => !usable.has(normalize(term)));
  const untaught = () =>
    [
      ...terms.filter((t) => !USABLE.includes(t.status)).map((t) => t.term),
      ...pending,
      ...(context.glossary ?? []),
    ]
      .filter((term, i, all) => !usable.has(normalize(term)) && all.indexOf(term) === i)
      .map((term) => ({ term, carded: pending.includes(term) }));

  walk(blocks, (block) => {
    if (!allowed.includes(block.type)) {
      issues.push({
        code: "surface/not-allowed",
        message: `A ${block.type} block can't be used in the ${context.surface}. Allowed there: ${allowed.join(", ")}.`,
        blockId: block.id,
      });
    }
    if (block.type === "word") {
      issues.push(...cardIssues(block, terms, pending, usable));
      const given = pending.find((term) => cardNames(block.term, term));
      usable.add(normalize(given ?? block.term));
    }
    const left = untaught();
    for (const text of visibleText(block)) {
      issues.push(...scaffolding(text, block.id, usable), ...untaughtTerms(text, block.id, left));
    }
  });
  for (const term of pending.filter((t) => !usable.has(normalize(t))))
    issues.push({
      code: "word/missing-card",
      message: `"${term}" is new here: give it a word card (:::word{term="${term}"}) with what it means, in words the learner already holds, before the first time it is used.`,
    });
  return issues;
}

/**
 * A word card gives a word the learner doesn't hold, where this content teaches it: not a word they
 * already hold, and not one of the track's terms that is taught somewhere else. A word the track
 * doesn't list (a label the lesson coins) may have one.
 */
function cardIssues(
  card: Extract<Block, { type: "word" }>,
  terms: readonly TrackTerm[],
  pending: readonly string[],
  usable: ReadonlySet<string>,
): Issue[] {
  if (pending.some((term) => cardNames(card.term, term))) return [];
  const listed = terms.find((t) => cardNames(card.term, t.term));
  if (usable.has(normalize(card.term)) || (listed && USABLE.includes(listed.status)))
    return [
      {
        code: "word/held",
        message: `The learner already holds "${card.term}": use it without a word card.`,
        blockId: card.id,
      },
    ];
  if (listed)
    return [
      {
        code: "word/not-here",
        message: `"${listed.term}" isn't taught here: leave out its word card, and describe it in plain words until the step that teaches it.`,
        blockId: card.id,
      },
    ];
  return [];
}

/** Validates a lesson step, heading included, on the lesson surface. */
export function validateStep(step: LessonStep, context: Omit<ValidateContext, "surface">): Issue[] {
  const heading: Block = { id: `${step.id}.b1`, type: "heading", depth: 2, children: step.heading };
  const blocks = step.check ? [heading, ...step.body, step.check] : [heading, ...step.body];
  return validate(blocks, { ...context, surface: "lesson" });
}

function walk(blocks: readonly Block[], visit: (block: Block) => void): void {
  for (const block of blocks) {
    visit(block);
    if (block.type === "list") for (const item of block.items) walk(item, visit);
    if (
      block.type === "quote" ||
      block.type === "check" ||
      block.type === "word" ||
      block.type === "about"
    )
      walk(block.children, visit);
  }
}

/** The text a learner reads in this block itself (nested blocks are visited on their own). */
function visibleText(block: Block): string[] {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return [inlineText(block.children)];
    case "table":
      return [...block.header, ...block.rows.flat()].map(inlineText);
    case "diagram":
      return [block.caption, ...diagramLabels(block.source)];
    case "stepper":
      return block.frames.flatMap((frame: DiagramFrame) => [
        frame.caption,
        ...diagramLabels(frame.source),
      ]);
    case "video":
    case "image":
    case "audio":
      return block.caption ? [block.caption] : [];
    case "link":
      return [block.title, block.why];
    default:
      return [];
  }
}

/** Prose only: inline code and maths are not checked. */
function inlineText(inlines: readonly Inline[]): string {
  return inlines
    .map((inline) => {
      switch (inline.type) {
        case "text":
          return inline.value;
        case "strong":
        case "emphasis":
        case "link":
          return inlineText(inline.children);
        default:
          return " ";
      }
    })
    .join("");
}

/**
 * Labels a learner reads in Mermaid source: node text in brackets, parentheses and braces, edge
 * labels between pipes, and sequence-diagram messages. Keywords like "flowchart" are not labels.
 */
const LABEL =
  /\|([^|\n]+)\||\["([^"\n]*)"\]|\[([^\]"\n(]+)\]|\("([^"\n]*)"\)|\(([^)"\n(]+)\)|\{"?([^}"\n]+)"?\}|^\s*[\w ]+-[-.]*>>?[\w ]+:\s*(.+)$/gm;

function diagramLabels(source: string): string[] {
  return [...source.matchAll(LABEL)].map((m) => {
    // Exactly one alternative matched; the other groups are undefined at runtime.
    const groups: (string | undefined)[] = m.slice(1);
    return groups.find((g) => g !== undefined) ?? "";
  });
}

function scaffolding(text: string, blockId: string, usable: Set<string>): Issue[] {
  const hits: { index: number; end: number; word: string; sure: boolean }[] = [];
  for (const pattern of MACHINERY) {
    for (const m of text.matchAll(pattern)) {
      hits.push({ index: m.index, end: m.index + m[0].length, word: m[0], sure: true });
    }
  }
  for (const m of text.matchAll(MAYBE_MACHINERY)) {
    const overlaps = hits.some((h) => h.sure && m.index < h.end && m.index + m[0].length > h.index);
    if (!overlaps)
      hits.push({ index: m.index, end: m.index + m[0].length, word: m[0], sure: false });
  }
  return hits
    .filter((hit) => !usable.has(normalize(hit.word)))
    .sort((a, b) => a.index - b.index)
    .map((hit): Issue =>
      hit.sure
        ? {
            code: "scaffolding/word",
            message: `Learners never see the method's machinery: "${hit.word}". Say what a tutor would say instead.`,
            blockId,
          }
        : {
            code: "scaffolding/maybe",
            severity: "review",
            word: hit.word,
            message: `"${hit.word}" may refer to the method's machinery; check it is meant in its everyday or domain sense.`,
            blockId,
          },
    );
}

function untaughtTerms(
  text: string,
  blockId: string,
  terms: readonly { term: string; carded: boolean }[],
): Issue[] {
  return terms
    .map((t) => ({ ...t, index: text.search(termPattern(t.term)) }))
    .filter(({ index }) => index !== -1)
    .sort((a, b) => a.index - b.index)
    .map(({ term, carded }) =>
      carded
        ? {
            code: "word/before-card",
            message: `"${term}" is used before its word card. Name it only from its card on, headings included: the idea first, in plain words, then the card, then the name.`,
            blockId,
          }
        : {
            code: "term/untaught",
            message: `"${term}" hasn't been taught yet; describe it in plain words, or introduce it where it earns its name.`,
            blockId,
          },
    );
}

function termPattern(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`\\b${escaped}(?:s|es)?\\b`, "i");
}

/** Lowercased and without a plural "s", for comparing a found word with a term. */
function normalize(word: string): string {
  return word
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/(?:es|s)$/, "");
}
