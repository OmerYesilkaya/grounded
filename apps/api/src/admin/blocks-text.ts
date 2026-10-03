import type { Block, Inline } from "@grounded/content";

/*
 * What the learner was shown, as text for the admin panel (design §10.1): the panel never renders
 * model output as HTML, so tutor messages and lesson steps reach it flattened here. Markup that
 * matters for reading the teaching is kept as plain marks: a check, a word card, a diagram's
 * caption, a citation's number.
 */

export function blocksText(blocks: readonly Block[] | null | undefined): string {
  return (blocks ?? [])
    .map(blockText)
    .filter((text) => text !== "")
    .join("\n\n");
}

export function inlineText(inlines: readonly Inline[]): string {
  return inlines
    .map((inline) => {
      switch (inline.type) {
        case "text":
          return inline.value;
        case "strong":
          return `**${inlineText(inline.children)}**`;
        case "emphasis":
          return `*${inlineText(inline.children)}*`;
        case "inlineCode":
          return `\`${inline.value}\``;
        case "inlineMath":
          return `$${inline.value}$`;
        case "link":
          return `${inlineText(inline.children)} <${inline.url}>`;
        case "cite":
          return `[${String(inline.ref)}]`;
        case "break":
          return "\n";
      }
    })
    .join("");
}

const indent = (text: string) =>
  text
    .split("\n")
    .map((line) => (line ? `  ${line}` : line))
    .join("\n");

function blockText(block: Block): string {
  switch (block.type) {
    case "heading":
      return `${"#".repeat(block.depth)} ${inlineText(block.children)}`;
    case "paragraph":
      return inlineText(block.children);
    case "list":
      return block.items
        .map((item, i) => {
          const mark = block.ordered ? `${String(i + 1)}.` : "-";
          return `${mark} ${blocksText(item).replace(/\n/g, "\n  ")}`;
        })
        .join("\n");
    case "quote":
      return blocksText(block.children)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "code":
      return `\`\`\`${block.lang ?? ""}\n${block.value}\n\`\`\``;
    case "math":
      return `$$\n${block.value}\n$$`;
    case "table":
      return [block.header, ...block.rows]
        .map((row) => `| ${row.map(inlineText).join(" | ")} |`)
        .join("\n");
    case "divider":
      return "---";
    case "diagram":
      return `[diagram: ${block.caption}]\n${block.source}`;
    case "stepper":
      return block.frames
        .map((frame, i) => `[diagram ${String(i + 1)}: ${frame.caption}]\n${frame.source}`)
        .join("\n");
    case "chart":
      return "[chart]";
    case "check":
      return `[check]\n${indent(blocksText(block.children))}`;
    case "word":
      return `[word: ${block.term}]\n${indent(blocksText(block.children))}`;
    case "about":
      return `[about: ${block.name}${block.track ? `; a track of its own: ${block.track}` : ""}]\n${indent(blocksText(block.children))}`;
    case "video":
      return `[video: youtube ${block.videoId}${block.caption ? `, ${block.caption}` : ""}]`;
    case "image":
      return `[image${block.caption ? `: ${block.caption}` : ""}]`;
    case "audio":
      return `[audio${block.caption ? `: ${block.caption}` : ""}]`;
    case "link":
      return `[link: ${block.title} <${block.url}>] ${block.why}`;
    case "picture":
      return `[picture: ${block.alt}]`;
  }
}
