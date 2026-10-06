import { describe, expect, it } from "vitest";
import { checkVerdictIssues, type CheckVerdict } from "./check.js";

const codes = (
  reply: string,
  freshQuestion: string | null,
  rest: Partial<Pick<CheckVerdict, "verdict" | "actions">> = {},
) =>
  checkVerdictIssues({
    verdict: "missed",
    reply,
    freshQuestion,
    actions: [],
    ...rest,
  }).map((i) => i.code);

describe("checkVerdictIssues", () => {
  it("flags a repair that still asks while a fresh question is given", () => {
    expect(codes("B copied 5 first. So what does memory hold?", "What is the worst?")).toEqual([
      "check/repair-asks",
    ]);
    expect(codes("B copied 5 first. **What does memory hold?**", "Why?")).toEqual([
      "check/repair-asks",
    ]);
    expect(codes("B copied 5 first (what does memory hold?)\n", "Why?")).toEqual([
      "check/repair-asks",
    ]);
  });

  it("lets a repair that ends without a question through", () => {
    expect(codes("B copied 5 before A put 6 back.", "What is the worst balance?")).toEqual([]);
    expect(codes("Is it 5? No: B copied it before A put 6 back.", "Why?")).toEqual([]);
  });

  it("lets a repair ask when no fresh question follows it", () => {
    expect(codes("This is still settling. Shall we come back to it?", null)).toEqual([]);
    expect(codes("That's it.", null)).toEqual([]);
  });

  it("wants a fresh question after an unproven answer, and no term confirmed from it", () => {
    expect(codes("That names it.", null, { verdict: "unproven" })).toEqual([
      "check/unproven-asks-nothing",
    ]);
    expect(
      codes("That names it.", "What does it do with a bad email?", {
        verdict: "unproven",
        actions: [
          { type: "set-term-status", term: "request handler", status: "confirmed", evidence: "" },
        ],
      }),
    ).toEqual(["check/unproven-confirms"]);
    expect(
      codes("That names it.", "What does it do with a bad email?", {
        verdict: "unproven",
        actions: [{ type: "set-language", language: "English" }],
      }),
    ).toEqual([]);
  });

  it("lets a landed answer confirm a term without a fresh question", () => {
    expect(
      codes("Exactly.", null, {
        verdict: "landed",
        actions: [
          { type: "set-term-status", term: "request handler", status: "confirmed", evidence: "" },
        ],
      }),
    ).toEqual([]);
  });
});
