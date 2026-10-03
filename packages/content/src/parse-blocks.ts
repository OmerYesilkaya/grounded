import type { PhrasingContent, Root, RootContent } from "mdast";
import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import {
  convertContainerDirective,
  convertLeafDirective,
  convertTypedCode,
} from "./typed-blocks.js";
import { lineOf } from "./position.js";
import type { Block, Inline, Issue, ParseResult } from "./types.js";

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkDirective);

export function parseMarkdown(markdown: string): Root {
  return processor.parse(markdown);
}

export interface ParseOptions {
  /** Prefix for block ids (default "b"), e.g. "s2.b" inside a lesson step. */
  idPrefix?: string;
}

/** Parses the model's markdown into blocks. Malformed content becomes issues, never exceptions. */
export function parseBlocks(markdown: string, options: ParseOptions = {}): ParseResult {
  const issues: Issue[] = [];
  const blocks = convertNodes(parseMarkdown(markdown).children, options.idPrefix ?? "b", issues);
  return { blocks, issues };
}

/**
 * Where the app serves a picture the learner put in an answer: `/api/assignments/<id>/files/<id>`.
 * Only these become pictures; any other image in an answer is left out.
 */
export const ANSWER_PICTURE = /^\/api\/assignments\/[0-9a-f-]{36}\/files\/[0-9a-f-]{36}$/;

/**
 * Parses what the learner wrote in an answer (design §7.4): the same markdown as the tutor's, and
 * their own pictures, each a paragraph of its own (`![…](/api/assignments/…/files/…)`). The
 * learner's words are never validated, only shown; what can't be shown is left out.
 */
export function parseAnswer(markdown: string, options: ParseOptions = {}): Block[] {
  const prefix = options.idPrefix ?? "b";
  const nodes = parseMarkdown(markdown).children;
  const blocks: Block[] = [];
  nodes.forEach((node, index) => {
    const id = `${prefix}${String(index + 1)}`;
    const pictures =
      node.type === "paragraph"
        ? node.children.filter((child) => child.type === "image" && ANSWER_PICTURE.test(child.url))
        : [];
    if (node.type === "paragraph" && pictures.length > 0) {
      // A paragraph holding pictures is shown as the pictures, then whatever else it says.
      pictures.forEach((picture, i) => {
        if (picture.type === "image")
          blocks.push({
            id: `${id}.${String(i + 1)}`,
            type: "picture",
            url: picture.url,
            alt: picture.alt ?? "",
          });
      });
      const rest = node.children.filter((child) => child.type !== "image");
      const text = convertNodes([{ ...node, children: rest }], `${id}.t`, []);
      if (rest.some((child) => child.type !== "text" || child.value.trim())) blocks.push(...text);
      return;
    }
    blocks.push(...convertNodes([node], prefix, [], index + 1));
  });
  return blocks;
}

/**
 * Ids follow the node's position in the source ("b3", "b3.1" for its first child), so a node that is
 * rejected still uses up its number and the ids of its neighbours don't depend on it.
 */
export function convertNodes(
  nodes: RootContent[],
  idPrefix: string,
  issues: Issue[],
  firstIndex = 1,
): Block[] {
  const blocks: Block[] = [];
  nodes.forEach((node, index) => {
    const block = convertNode(node, `${idPrefix}${String(firstIndex + index)}`, issues);
    if (block) blocks.push(block);
  });
  return blocks;
}

function convertNode(node: RootContent, id: string, issues: Issue[]): Block | null {
  switch (node.type) {
    case "heading":
      return {
        id,
        type: "heading",
        depth: node.depth,
        children: convertInlines(node.children, issues),
      };
    case "paragraph":
      return { id, type: "paragraph", children: convertInlines(node.children, issues) };
    case "list":
      return {
        id,
        type: "list",
        ordered: node.ordered ?? false,
        items: node.children.map((item, i) =>
          convertNodes(item.children, `${id}.${String(i + 1)}.`, issues),
        ),
      };
    case "blockquote":
      return { id, type: "quote", children: convertNodes(node.children, `${id}.`, issues) };
    case "code": {
      const typed = convertTypedCode(node, id, issues);
      if (typed !== undefined) return typed;
      return { id, type: "code", lang: node.lang ?? null, value: node.value };
    }
    case "leafDirective":
      return convertLeafDirective(node, id, issues);
    case "containerDirective":
      return convertContainerDirective(node, id, issues, (prefix) =>
        convertNodes(node.children, prefix, issues),
      );
    case "math":
      return { id, type: "math", value: node.value };
    case "table": {
      const [header, ...rows] = node.children.map((row) =>
        row.children.map((cell) => convertInlines(cell.children, issues)),
      );
      return { id, type: "table", header: header ?? [], rows };
    }
    case "thematicBreak":
      return { id, type: "divider" };
    case "html":
      issues.push({
        code: "html",
        message: "HTML is not allowed; write markdown.",
        ...lineOf(node),
      });
      return null;
    default:
      issues.push({
        code: "unsupported",
        message: `"${node.type}" content is not supported here.`,
        ...lineOf(node),
      });
      return null;
  }
}

function convertInlines(nodes: PhrasingContent[], issues: Issue[]): Inline[] {
  const out: Inline[] = [];
  const pushText = (value: string) => {
    const last = out.at(-1);
    if (last?.type === "text") last.value += value;
    else out.push({ type: "text", value });
  };
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        pushText(node.value);
        break;
      case "strong":
        out.push({ type: "strong", children: convertInlines(node.children, issues) });
        break;
      case "emphasis":
        out.push({ type: "emphasis", children: convertInlines(node.children, issues) });
        break;
      case "inlineCode":
        out.push({ type: "inlineCode", value: node.value });
        break;
      case "inlineMath":
        out.push({ type: "inlineMath", value: node.value });
        break;
      case "link":
        out.push({ type: "link", url: node.url, children: convertInlines(node.children, issues) });
        break;
      case "break":
        out.push({ type: "break" });
        break;
      case "textDirective": {
        if (node.name === "cite") {
          const ref = toPlainText(node).trim();
          if (/^[1-9]\d*$/.test(ref)) out.push({ type: "cite", ref: Number(ref), source: null });
          else
            issues.push({
              code: "cite/malformed",
              message: `A citation names one source by its number, as \`:cite[3]\`; "${ref}" isn't one.`,
              ...lineOf(node),
            });
          break;
        }
        // "note:this" is prose, not a directive: put the colon and the word back.
        pushText(`:${node.name}`);
        for (const child of convertInlines(node.children, issues)) {
          if (child.type === "text") pushText(child.value);
          else out.push(child);
        }
        break;
      }
      case "image":
        issues.push({
          code: "markdown-image",
          message: "Images must come from the find_image tool as an ::image block, not a URL.",
          ...lineOf(node),
        });
        break;
      case "html":
        issues.push({
          code: "html",
          message: "HTML is not allowed; write markdown.",
          ...lineOf(node),
        });
        break;
      default:
        pushText(toPlainText(node));
    }
  }
  return out;
}

function toPlainText(node: PhrasingContent): string {
  if ("value" in node) return node.value;
  if ("children" in node) return node.children.map(toPlainText).join("");
  return "";
}
