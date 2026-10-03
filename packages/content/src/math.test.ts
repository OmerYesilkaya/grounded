import { describe, expect, it } from "vitest";
import { parseBlocks } from "./index.js";

function inlines(markdown: string) {
  const [block] = parseBlocks(markdown).blocks;
  return block?.type === "paragraph" ? block.children : undefined;
}

describe("maths and money", () => {
  it("leaves a dollar next to a space as money", () => {
    expect(inlines("100$ in a year becomes 10$.")).toEqual([
      { type: "text", value: "100$ in a year becomes 10$." },
    ]);
    expect(inlines("It costs $5 and then $6.")).toEqual([
      { type: "text", value: "It costs $5 and then $6." },
    ]);
  });

  it("doesn't close a formula before a digit", () => {
    expect(inlines("Between $5 and 10$20 apiece.")).toEqual([
      { type: "text", value: "Between $5 and 10$20 apiece." },
    ]);
  });

  it("still reads a formula that hugs its dollars", () => {
    expect(inlines("Let $r$ be the rate, so $100(1+r)$ after a year.")).toEqual([
      { type: "text", value: "Let " },
      { type: "inlineMath", value: "r" },
      { type: "text", value: " be the rate, so " },
      { type: "inlineMath", value: "100(1+r)" },
      { type: "text", value: " after a year." },
    ]);
  });

  it("reads money and a formula in one sentence", () => {
    expect(inlines("At 10%, $100 grows to $110, that is $100 \\cdot 1.1$.")).toEqual([
      { type: "text", value: "At 10%, $100 grows to $110, that is " },
      { type: "inlineMath", value: "100 \\cdot 1.1" },
      { type: "text", value: "." },
    ]);
  });

  it("keeps an escaped dollar inside a formula", () => {
    expect(inlines("A price of $\\$5 \\times n$ in total.")).toEqual([
      { type: "text", value: "A price of " },
      { type: "inlineMath", value: "\\$5 \\times n" },
      { type: "text", value: " in total." },
    ]);
  });

  it("keeps an escaped dollar as text", () => {
    expect(inlines("Pay \\$5 and \\$x\\$.")).toEqual([{ type: "text", value: "Pay $5 and $x$." }]);
  });

  it("keeps `$$…$$` within a line and on a line of its own", () => {
    expect(inlines("So $$ a + b $$ holds.")).toEqual([
      { type: "text", value: "So " },
      { type: "inlineMath", value: "a + b" },
      { type: "text", value: " holds." },
    ]);
    expect(parseBlocks("$$\nE = mc^2\n$$").blocks).toEqual([
      { id: "b1", type: "math", value: "E = mc^2" },
    ]);
  });
});
