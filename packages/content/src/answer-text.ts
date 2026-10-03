import type { Block, Inline } from "./types.js";

/**
 * An answer's text as the page shows it (design §7.4): what a margin comment's quote is found in.
 * Blocks are separated by a line break, as the page's passages read them (apps/web/src/lesson/
 * passages.ts); maths and code are their source, pictures nothing.
 */
export function answerText(blocks: readonly Block[]): string {
  return blocks
    .map(blockText)
    .filter((text) => text !== "")
    .join("\n");
}

function blockText(block: Block): string {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return inlineText(block.children);
    case "list":
      return block.items.map(answerText).join("\n");
    case "quote":
      return answerText(block.children);
    case "code":
    case "math":
      return block.value;
    case "table":
      return [block.header, ...block.rows].map((row) => row.map(inlineText).join("\n")).join("\n");
    default:
      return "";
  }
}

function inlineText(inlines: readonly Inline[]): string {
  return inlines
    .map((inline) => {
      switch (inline.type) {
        case "text":
        case "inlineCode":
        case "inlineMath":
          return inline.value;
        case "strong":
        case "emphasis":
        case "link":
          return inlineText(inline.children);
        case "break":
          return "\n";
        case "cite":
          return "";
      }
    })
    .join("");
}
