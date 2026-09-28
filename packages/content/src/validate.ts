import type { Block, BlockType, DiagramFrame, Inline, Issue, LessonStep } from "./types.js";

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
    "image",
    "video",
    "audio",
    "link",
  ],
  aside: WITH_DRAWINGS,
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
  /** Terms the content itself introduces (a lesson step's new names), allowed here. */
  introduced?: readonly string[];
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
  const usable = new Set(
    [
      ...(context.terms ?? []).filter((t) => USABLE.includes(t.status)).map((t) => t.term),
      ...(context.introduced ?? []),
    ].map(normalize),
  );
  const untaught = [
    ...(context.terms ?? []).filter((t) => !USABLE.includes(t.status)).map((t) => t.term),
    ...(context.glossary ?? []),
  ].filter((term) => !usable.has(normalize(term)));

  walk(blocks, (block) => {
    if (!allowed.includes(block.type)) {
      issues.push({
        code: "surface/not-allowed",
        message: `A ${block.type} block can't be used in the ${context.surface}. Allowed there: ${allowed.join(", ")}.`,
        blockId: block.id,
      });
    }
    for (const text of visibleText(block)) {
      issues.push(
        ...scaffolding(text, block.id, usable),
        ...untaughtTerms(text, block.id, untaught),
      );
    }
  });
  return issues;
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
    if (block.type === "quote" || block.type === "check") walk(block.children, visit);
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
            message: `"${hit.word}" may refer to the method's machinery; check it is meant in its everyday or domain sense.`,
            blockId,
          },
    );
}

function untaughtTerms(text: string, blockId: string, terms: readonly string[]): Issue[] {
  return terms
    .map((term) => ({ term, index: text.search(termPattern(term)) }))
    .filter(({ index }) => index !== -1)
    .sort((a, b) => a.index - b.index)
    .map(({ term }) => ({
      code: "term/untaught",
      message: `"${term}" hasn't been taught yet; describe it in plain words, or introduce it where it earns its name.`,
      blockId,
    }));
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
