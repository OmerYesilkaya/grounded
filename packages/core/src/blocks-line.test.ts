import { describe, expect, it } from "vitest";
import { allowedBlocksLine } from "./blocks-line.js";

describe("allowedBlocksLine", () => {
  it("lists what the homework may use, leaving out what the call can't make", () => {
    expect(allowedBlocksLine("homework", "the homework", ["image", "audio"])).toBe(
      "Blocks you may use in the homework: paragraphs, lists, quotes, code, maths, tables, headings, dividers, diagrams, videos and link cards. Nothing else is shown.",
    );
  });
});
