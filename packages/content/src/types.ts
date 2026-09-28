/** Inline content inside paragraphs, headings and list items. */
export type Inline =
  | { type: "text"; value: string }
  | { type: "strong"; children: Inline[] }
  | { type: "emphasis"; children: Inline[] }
  | { type: "inlineCode"; value: string }
  | { type: "inlineMath"; value: string }
  | { type: "link"; url: string; children: Inline[] }
  | { type: "break" };

/**
 * The block tree: what the app stores and renders. The model never produces it directly; it is
 * parsed from the model's markdown, and every block gets an id that stays fixed once stored.
 */
export type Block =
  | { id: string; type: "heading"; depth: number; children: Inline[] }
  | { id: string; type: "paragraph"; children: Inline[] }
  | { id: string; type: "list"; ordered: boolean; items: Block[][] }
  | { id: string; type: "quote"; children: Block[] }
  | { id: string; type: "code"; lang: string | null; value: string }
  | { id: string; type: "math"; value: string }
  | { id: string; type: "table"; header: Inline[][]; rows: Inline[][][] }
  | { id: string; type: "divider" }
  | {
      id: string;
      type: "diagram";
      syntax: DiagramSyntax;
      caption: string;
      highlight: string | null;
      source: string;
    }
  | { id: string; type: "stepper"; frames: DiagramFrame[] }
  | { id: string; type: "chart"; spec: Record<string, unknown>; source: string | null }
  | { id: string; type: "check"; children: Block[] }
  | {
      id: string;
      type: "video";
      provider: "youtube";
      videoId: string;
      start: number | null;
      end: number | null;
      caption: string | null;
    }
  | { id: string; type: "image"; ref: string; caption: string | null }
  | { id: string; type: "audio"; ref: string; caption: string | null }
  | { id: string; type: "link"; url: string; title: string; why: string };

/** Diagram engines are swappable; each stored diagram records the syntax it was written in. */
export type DiagramSyntax = "mermaid";

export interface DiagramFrame {
  caption: string;
  syntax: DiagramSyntax;
  source: string;
  highlight?: string;
}

export type BlockType = Block["type"];

export interface Issue {
  /** Machine-readable kind, e.g. "diagram/missing-caption". */
  code: string;
  /** Written to be fed back to the model on a retry. */
  message: string;
  /** "review": needs a judgement in context (a cheap model decides). Absent: an error to regenerate. */
  severity?: "review";
  blockId?: string;
  /** Set for issues inside a lesson step, so only that step is regenerated. */
  stepId?: string;
  line?: number;
}

export interface ParseResult {
  blocks: Block[];
  issues: Issue[];
}

export type CheckBlock = Extract<Block, { type: "check" }>;

/**
 * One step of a lesson, revealed on its own. It ends in the check that unlocks the next step, or,
 * where nothing ahead rests on it yet, in none: the next step then opens with it.
 */
export interface LessonStep {
  id: string;
  heading: Inline[];
  body: Block[];
  check: CheckBlock | null;
}

export interface LessonParseResult {
  /** Only structurally sound steps; a step with any issue is left out and named in `issues`. */
  steps: LessonStep[];
  issues: Issue[];
}
