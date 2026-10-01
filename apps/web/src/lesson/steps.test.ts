import { describe, expect, it } from "vitest";
import { verdictHold } from "./steps";

describe("verdictHold", () => {
  it("holds a short verdict for at least a moment and a long one for no more than five seconds", () => {
    expect(verdictHold("")).toBe(1500);
    expect(verdictHold("Yes.")).toBe(1500);
    expect(verdictHold("x".repeat(400))).toBe(5000);
  });

  it("grows with the words to read, at about 300 words a minute", () => {
    const sentence = "Yes — each works from a copy that is already out of date.";
    expect(verdictHold(sentence)).toBe(600 + sentence.length * 40);
    expect(verdictHold(sentence + sentence)).toBeGreaterThan(verdictHold(sentence));
  });
});
