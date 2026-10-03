import type { Block, CitedSource, Inline, LessonStep } from "./types.js";

/**
 * The sources a lesson's steps cite, each once, in the order the lesson first cites them (design
 * §9.1): the lesson's "Sources" list, whose numbers its citation marks show.
 */
export function citedSources(steps: readonly LessonStep[]): CitedSource[] {
  const cited = new Map<string, CitedSource>();
  const visit = (inlines: readonly Inline[]): void => {
    for (const inline of inlines) {
      if (inline.type === "cite" && inline.source && !cited.has(inline.source.url))
        cited.set(inline.source.url, inline.source);
      if ("children" in inline) visit(inline.children);
    }
  };
  const walk = (blocks: readonly Block[]): void => {
    for (const block of blocks) {
      if (block.type === "heading" || block.type === "paragraph") visit(block.children);
      if (block.type === "list") block.items.forEach(walk);
      if (block.type === "table") [block.header, ...block.rows].flat().forEach(visit);
      if (
        block.type === "quote" ||
        block.type === "check" ||
        block.type === "word" ||
        block.type === "about"
      )
        walk(block.children);
    }
  };
  for (const step of steps) {
    visit(step.heading);
    walk(step.body);
    if (step.check) walk([step.check]);
  }
  return [...cited.values()];
}
