import { describe, expect, it } from "vitest";
import { alreadyHeldSoFar, checkRecord } from "./check-record.js";

const input = {
  steps: [
    { id: "s1", check: null },
    { id: "s2", check: { steps: ["s1", "s2"], terms: ["BC dating", "Nile flood"], gates: true } },
    { id: "s3", check: { steps: ["s3"], terms: [], gates: false } },
  ],
  headings: ["Counting back", "The flood", "Two lands"],
  sources: {
    s1: "## Counting back\n\nBody.",
    s2: "## The flood\n\nBody.\n\n:::check\nWhich is older, 800 BC or 1200 BC?\n:::",
    s3: "## Two lands\n\nBody.\n\n:::check\nWhy south?\n:::",
  },
  threads: [
    { stepId: "s2", role: "learner", text: "1200 BC. I knew this already.", verdict: null },
    { stepId: "s2", role: "tutor", text: "Right.", verdict: "landed" },
  ],
  notes: {},
  alreadyHeld: { s2: 'Reads BC dates and their gaps; said so: "I knew this already."' },
};

describe("checkRecord", () => {
  it("lists each answered check with what it covered, its question, its thread and what was already held", () => {
    expect(checkRecord(input)).toBe(
      [
        '### The check after step 2, "The flood" — it checks: BC dating, Nile flood',
        "Question: Which is older, 800 BC or 1200 BC?",
        "Learner: 1200 BC. I knew this already.",
        "Tutor (landed): Right.",
        'Already held before the lesson taught it: Reads BC dates and their gaps; said so: "I knew this already."',
      ].join("\n"),
    );
  });

  it("is empty until a check is answered", () => {
    expect(checkRecord({ ...input, threads: [] })).toBeNull();
  });
});

describe("alreadyHeldSoFar", () => {
  it("lists what the learner already held, or nothing", () => {
    expect(alreadyHeldSoFar({ s1: "a", s3: "b" })).toBe("- a\n- b");
    expect(alreadyHeldSoFar({})).toBeNull();
  });
});
