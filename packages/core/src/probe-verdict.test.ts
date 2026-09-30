import { describe, expect, it } from "vitest";
import {
  probeAnswers,
  probePart,
  probeVerdictSchema,
  verdictOffered,
  verdictText,
  type SessionPhase,
} from "./index.js";

const chat = [
  { role: "tutor", kind: "message" },
  { role: "learner", kind: "message" },
  { role: "tutor", kind: "message" },
  { role: "learner", kind: "message" },
  { role: "tutor", kind: "plan" },
  // A revision asked for is the plan's, not the probe's.
  { role: "learner", kind: "message" },
  { role: "tutor", kind: "plan" },
] as const;

describe("the probe's part of the chat", () => {
  it("is everything before the first plan", () => {
    expect(probePart(chat)).toHaveLength(4);
    expect(probeAnswers(chat)).toBe(2);
  });

  it("is the whole chat while the plan is still being written", () => {
    expect(probePart(chat.slice(0, 4))).toHaveLength(4);
    expect(probeAnswers([{ role: "tutor", kind: "message" }])).toBe(0);
  });
});

describe("when 'See where you stand' is offered", () => {
  const offered = (input: Partial<Parameters<typeof verdictOffered>[0]> = {}) =>
    verdictOffered({ final: false, first: true, phase: "plan", answers: 1, ...input });

  it("is offered once a track's first probe is over, however far the session has gone", () => {
    for (const phase of ["plan", "lesson", "homework", "close", "closed"] as SessionPhase[])
      expect(offered({ phase })).toBe(true);
  });

  it("isn't offered while the probe goes on", () => {
    expect(offered({ phase: "probe" })).toBe(false);
    expect(offered({ phase: "review" })).toBe(false);
  });

  it("isn't offered after a later session's probe, nor in the final", () => {
    expect(offered({ first: false })).toBe(false);
    expect(offered({ final: true })).toBe(false);
  });

  it("isn't offered when the learner skipped to the plan before any answer", () => {
    expect(offered({ answers: 0 })).toBe(false);
  });
});

describe("the verdict", () => {
  it("is bands and prose, never a number", () => {
    const verdict = probeVerdictSchema.parse({
      strands: [{ name: "Adding one", band: "working", text: "You said it changes memory." }],
      overall: { band: "starting", text: "You start from the idea of memory." },
    });
    expect(() =>
      probeVerdictSchema.parse({ ...verdict, overall: { band: 40, text: "" } }),
    ).toThrow();
    expect(verdictText(verdict)).toBe(
      "You start from the idea of memory.\n\nAdding one: You said it changes memory.",
    );
  });
});
