import { answerText, parseAnswer } from "@grounded/content";
import { describe, expect, it } from "vitest";
import { placeQuote, reviewRecord } from "./assignment-review.js";

describe("placeQuote", () => {
  const text = answerText(
    parseAnswer("Adding one is **one step**: the CPU just\nbumps it.\n\n- then `x` is 2001"),
  );

  it("finds the quote in the answer as the page shows it, with the text around it", () => {
    expect(placeQuote(text, "one step")).toEqual({
      quote: "one step",
      prefix: "Adding one is ",
      suffix: ": the CPU just\nbumps it.\nthen x is 2001",
    });
  });

  it("finds a quote copied with the answer's markdown, or its line break as a space", () => {
    expect(placeQuote(text, "**one step**")?.quote).toBe("one step");
    expect(placeQuote(text, "just bumps it")?.quote).toBe("just\nbumps it");
    expect(placeQuote(text, "then `x` is 2001")?.quote).toBe("then x is 2001");
  });

  it("finds nothing for words the answer doesn't have, or none", () => {
    expect(placeQuote(text, "three moves")).toBeNull();
    expect(placeQuote(text, "  ")).toBeNull();
  });
});

describe("reviewRecord", () => {
  it("gives each item's mark and each comment with its thread", () => {
    const record = reviewRecord({
      title: "Two workers",
      kind: "homework",
      checklist: [
        { id: "c1", text: "Why adding one is three moves" },
        { id: "c2", text: "How the moves interleave" },
      ],
      marks: [{ id: "c1", mark: "leaked", note: "Look at your first line again." }],
      comments: [
        {
          field: "Your explanation",
          quote: "one step",
          messages: [
            { role: "tutor", text: "What does the CPU do first?" },
            { role: "learner", text: "It reads it." },
          ],
          resolved: true,
        },
      ],
    });
    expect(record).toContain('### "Two workers" (homework)');
    expect(record).toContain(
      "- leaked: Why adding one is three moves (Look at your first line again.)",
    );
    expect(record).toContain("- not marked: How the moves interleave");
    expect(record).toContain("- On «one step» in Your explanation (the learner found the flaw):");
    expect(record).toContain("  Learner: It reads it.");
  });

  it("names a comment by its label, for a call to say which it means", () => {
    const record = reviewRecord({
      title: "Two workers",
      kind: "exam",
      checklist: [],
      marks: [],
      comments: [
        {
          field: "Your explanation",
          quote: "",
          messages: [{ role: "tutor", text: "What does the CPU do first?" }],
          resolved: false,
          label: "L1",
        },
      ],
    });
    expect(record).toContain('### "Two workers" (arc exam)');
    expect(record).toContain("- L1, on Your explanation (still open):");
  });
});
