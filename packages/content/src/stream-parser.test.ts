import { describe, expect, it } from "vitest";
import { createStreamParser, parseBlocks, type Block, type Issue } from "./index.js";

const LESSON = [
  "## Adding one is three moves",
  "",
  "The number lives in **memory**, and:",
  "",
  "1. copy it out",
  "2. change the copy",
  "",
  "```diagram",
  "caption: Three separate moves.",
  "---",
  "flowchart TB",
  "  M --> R",
  "```",
  "",
  ":::check",
  "In one sentence: what is in memory meanwhile?",
  ":::",
  "",
  "```diagram",
  "flowchart TB",
  "```",
  "",
  "Last paragraph.",
].join("\n");

function streamInChunks(text: string, size: number): { blocks: Block[]; issues: Issue[] } {
  const parser = createStreamParser();
  const blocks: Block[] = [];
  const issues: Issue[] = [];
  for (let i = 0; i < text.length; i += size) {
    const out = parser.push(text.slice(i, i + size));
    blocks.push(...out.blocks);
    issues.push(...out.issues);
  }
  const rest = parser.end();
  return { blocks: [...blocks, ...rest.blocks], issues: [...issues, ...rest.issues] };
}

describe("createStreamParser", () => {
  it("gives the same blocks and issues as parsing the whole text, however it is chunked", () => {
    const whole = parseBlocks(LESSON);
    for (const size of [1, 3, 7, 40, LESSON.length]) {
      expect(streamInChunks(LESSON, size)).toEqual(whole);
    }
  });

  it("holds back the last block until the next one starts", () => {
    const parser = createStreamParser();
    expect(parser.push("First para").blocks).toEqual([]);
    expect(parser.push("graph continues.\n\n").blocks).toEqual([]);
    expect(parser.push("Second").blocks).toEqual([
      {
        id: "b1",
        type: "paragraph",
        children: [{ type: "text", value: "First paragraph continues." }],
      },
    ]);
    expect(parser.end().blocks).toEqual([
      { id: "b2", type: "paragraph", children: [{ type: "text", value: "Second" }] },
    ]);
  });

  it("does not release a half-written check or diagram", () => {
    const parser = createStreamParser();
    expect(parser.push(":::check\nWhy is\n\nit so?").blocks).toEqual([]);
    expect(parser.push("\n:::\n\nNext.").blocks.map((b) => b.type)).toEqual(["check"]);
  });

  it("returns nothing after end", () => {
    const parser = createStreamParser();
    parser.push("Text.");
    parser.end();
    expect(parser.end()).toEqual({ blocks: [], issues: [] });
  });
});
