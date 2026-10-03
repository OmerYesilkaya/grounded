import { describe, expect, it } from "vitest";
import { parseBlocks } from "./index.js";

describe("parseBlocks", () => {
  it("turns markdown into blocks with stable ids", () => {
    const { blocks, issues } = parseBlocks(
      "## Adding one is three moves\n\nThe number lives in **memory**.",
    );

    expect(issues).toEqual([]);
    expect(blocks).toEqual([
      {
        id: "b1",
        type: "heading",
        depth: 2,
        children: [{ type: "text", value: "Adding one is three moves" }],
      },
      {
        id: "b2",
        type: "paragraph",
        children: [
          { type: "text", value: "The number lives in " },
          { type: "strong", children: [{ type: "text", value: "memory" }] },
          { type: "text", value: "." },
        ],
      },
    ]);
  });
});

describe("parseBlocks: text content", () => {
  it("keeps inline emphasis, code, math and links", () => {
    const { blocks } = parseBlocks(
      "An _idea_ like `x += 1` or $a^2$, see [docs](https://example.org).",
    );
    expect(blocks[0]).toEqual({
      id: "b1",
      type: "paragraph",
      children: [
        { type: "text", value: "An " },
        { type: "emphasis", children: [{ type: "text", value: "idea" }] },
        { type: "text", value: " like " },
        { type: "inlineCode", value: "x += 1" },
        { type: "text", value: " or " },
        { type: "inlineMath", value: "a^2" },
        { type: "text", value: ", see " },
        { type: "link", url: "https://example.org", children: [{ type: "text", value: "docs" }] },
        { type: "text", value: "." },
      ],
    });
  });

  it("parses lists and quotes with nested block ids", () => {
    const { blocks, issues } = parseBlocks("1. copy out\n2. change\n\n> put back");
    expect(issues).toEqual([]);
    expect(blocks).toEqual([
      {
        id: "b1",
        type: "list",
        ordered: true,
        items: [
          [{ id: "b1.1.1", type: "paragraph", children: [{ type: "text", value: "copy out" }] }],
          [{ id: "b1.2.1", type: "paragraph", children: [{ type: "text", value: "change" }] }],
        ],
      },
      {
        id: "b2",
        type: "quote",
        children: [
          { id: "b2.1", type: "paragraph", children: [{ type: "text", value: "put back" }] },
        ],
      },
    ]);
  });

  it("parses code, display math, tables and dividers", () => {
    const { blocks, issues } = parseBlocks(
      "```js\nlet n = 5;\n```\n\n$$\nE = mc^2\n$$\n\n| worker | sees |\n| --- | --- |\n| A | 5 |\n\n---",
    );
    expect(issues).toEqual([]);
    expect(blocks).toEqual([
      { id: "b1", type: "code", lang: "js", value: "let n = 5;" },
      { id: "b2", type: "math", value: "E = mc^2" },
      {
        id: "b3",
        type: "table",
        header: [[{ type: "text", value: "worker" }], [{ type: "text", value: "sees" }]],
        rows: [[[{ type: "text", value: "A" }], [{ type: "text", value: "5" }]]],
      },
      { id: "b4", type: "divider" },
    ]);
  });

  it("rejects raw HTML and markdown images with a message the model can act on", () => {
    const { blocks, issues } = parseBlocks(
      "<div>hi</div>\n\n![a cat](https://example.org/cat.png)",
    );
    expect(blocks).toEqual([{ id: "b2", type: "paragraph", children: [] }]);
    expect(issues).toEqual([
      { code: "html", message: "HTML is not allowed; write markdown.", line: 1 },
      {
        code: "markdown-image",
        message: "Images must come from the find_image tool as an ::image block, not a URL.",
        line: 3,
      },
    ]);
  });

  it("keeps a colon followed by a word as plain text", () => {
    const { blocks } = parseBlocks("Ratio note:this matters");
    expect(blocks[0]).toEqual({
      id: "b1",
      type: "paragraph",
      children: [{ type: "text", value: "Ratio note:this matters" }],
    });
  });

  it("turns :cite[n] into a citation of the nth source offered, its page not yet known", () => {
    const { blocks, issues } = parseBlocks("Light takes 8 minutes:cite[2] to arrive:cite[10].");
    expect(issues).toEqual([]);
    expect(blocks[0]).toEqual({
      id: "b1",
      type: "paragraph",
      children: [
        { type: "text", value: "Light takes 8 minutes" },
        { type: "cite", ref: 2, source: null },
        { type: "text", value: " to arrive" },
        { type: "cite", ref: 10, source: null },
        { type: "text", value: "." },
      ],
    });
  });

  it("leaves out a citation that names no source by its number", () => {
    const { blocks, issues } = parseBlocks("Light is fast:cite[https://example.org].");
    expect(blocks[0]).toEqual({
      id: "b1",
      type: "paragraph",
      children: [{ type: "text", value: "Light is fast." }],
    });
    expect(issues.map((i) => i.code)).toEqual(["cite/malformed"]);
  });
});
