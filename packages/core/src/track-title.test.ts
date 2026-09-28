import { describe, expect, it } from "vitest";
import { cleanTitle, needsNaming, standInTitle, TITLE_MAX } from "./track-title.js";

describe("track titles", () => {
  it("uses words that already are a name as they are", () => {
    expect(needsNaming("How software works")).toBe(false);
    expect(needsNaming("  Concurrency  ")).toBe(false);
  });

  it("asks for a name when the words run long or over lines", () => {
    expect(needsNaming("x".repeat(TITLE_MAX + 1))).toBe(true);
    expect(needsNaming("Backend interviews\nHere is my CV")).toBe(true);
  });

  it("stands in with the first line, cut at a word", () => {
    expect(standInTitle("Backend interviews\n\nHere is my CV")).toBe("Backend interviews");
    const long =
      "I want to learn how to pass backend and fullstack interviews at companies like the ones on my CV";
    const title = standInTitle(long);
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(title).toBe("I want to learn how to pass backend and fullstack…");
  });

  it("cleans the tutor's name of quotes, a full stop and extra space", () => {
    expect(cleanTitle(' "Backend interviews." ')).toBe("Backend interviews");
    expect(cleanTitle("«Mülakatlara hazırlık»")).toBe("Mülakatlara hazırlık");
    expect(cleanTitle("  ")).toBeNull();
    expect(cleanTitle("a ".repeat(50))?.length).toBeLessThanOrEqual(TITLE_MAX);
  });
});
