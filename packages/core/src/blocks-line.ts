import { ALLOWED_BLOCKS, type BlockType, type Surface } from "@grounded/content";

/** Each block type as a prompt names it. */
const BLOCK_NAMES: Partial<Record<BlockType, string>> = {
  paragraph: "paragraphs",
  list: "lists",
  quote: "quotes",
  code: "code",
  math: "maths",
  table: "tables",
  heading: "headings",
  divider: "dividers",
  diagram: "diagrams",
  stepper: "steppers",
  chart: "charts",
  image: "images",
  video: "videos",
  audio: "audio",
  link: "link cards",
  about: "preview cards (:::about) for a person, place or work",
};

/**
 * The blocks a surface allows (design §6.3), as the line its prompt carries: `what` is what the
 * call writes ("this answer", "the homework"); `without`, blocks the call can't make though the
 * surface allows them (an image, in a call with no tool to find one).
 */
export function allowedBlocksLine(
  surface: Surface,
  what: string,
  without: readonly BlockType[] = [],
): string {
  const names = ALLOWED_BLOCKS[surface]
    .filter((type) => !without.includes(type))
    .map((type) => BLOCK_NAMES[type] ?? type);
  return `Blocks you may use in ${what}: ${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}. Nothing else is shown.`;
}
