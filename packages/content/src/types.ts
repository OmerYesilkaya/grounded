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
  /**
   * A word card (design §6.2): a term the learner doesn't hold yet, given with what it means in
   * words they do hold, before the lesson uses it. `term` is written as the lesson names it.
   */
  | { id: string; type: "word"; term: string; children: Block[] }
  /**
   * A preview of a person, place or work the lesson leans on (design §6.2): who or what it is, in
   * a paragraph at most. `track` is set when there is too much to it for a preview: the goal of a
   * track of its own, which the learner can start from the card.
   */
  | { id: string; type: "about"; name: string; track: string | null; children: Block[] }
  | {
      id: string;
      type: "video";
      provider: "youtube";
      videoId: string;
      start: number | null;
      end: number | null;
      caption: string | null;
    }
  | { id: string; type: "image"; ref: string; caption: string | null; file: CommonsFile | null }
  | { id: string; type: "audio"; ref: string; caption: string | null; file: CommonsFile | null }
  | { id: string; type: "link"; url: string; title: string; why: string }
  /** A picture the learner put in their answer (a photo of a notebook page): never the tutor's. */
  | { id: string; type: "picture"; url: string; alt: string };

/**
 * A Wikimedia Commons file as the server resolved it (design §6.4): what the browser loads, and the
 * credit its licence asks for. Null when parsed; a stored image or audio block always has one.
 */
export interface CommonsFile {
  /** What the browser loads: a thumbnail of an image, a widely playable version of a recording. */
  url: string;
  /** The file's page on Commons, which the credit links to. */
  page: string;
  /** Who made it, as plain text, when Commons says. */
  credit: string | null;
  /** The licence's short name ("CC BY-SA 4.0", "Public domain"). */
  license: string;
  licenseUrl: string | null;
}

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
  /** For a review: the word to judge. */
  word?: string;
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
