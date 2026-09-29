import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  auditDecisionSchema,
  checkVerdictSchema,
  importReadingSchema,
  lessonOutlineSchema,
  planActionsSchema,
  probeDecisionSchema,
  sweepActionsSchema,
  teachBackDecisionSchema,
  trackActionsSchema,
} from "./index.js";

/**
 * Every object's properties must all be required, and there must be no `oneOf`: OpenAI's strict
 * structured outputs reject both (a live check failed on `oneOf`). Mock models can't catch this.
 */
function strictProblems(node: unknown, path = "$"): string[] {
  if (Array.isArray(node))
    return node.flatMap((child, i) => strictProblems(child, `${path}[${String(i)}]`));
  if (typeof node !== "object" || node === null) return [];
  const record = node as Record<string, unknown>;
  const problems: string[] = [];
  if ("oneOf" in record) problems.push(`${path} uses oneOf`);
  if (
    record.type === "object" &&
    typeof record.properties === "object" &&
    record.properties !== null
  ) {
    const required = new Set(Array.isArray(record.required) ? (record.required as string[]) : []);
    for (const key of Object.keys(record.properties)) {
      if (!required.has(key)) problems.push(`${path}.${key} is not required`);
    }
  }
  for (const [key, value] of Object.entries(record))
    problems.push(...strictProblems(value, `${path}.${key}`));
  return problems;
}

describe("model output schemas", () => {
  it.each([
    ["track actions", trackActionsSchema],
    ["sweep actions", sweepActionsSchema],
    ["check verdict", checkVerdictSchema],
    ["lesson outline", lessonOutlineSchema],
    ["probe decision", probeDecisionSchema],
    ["audit decision", auditDecisionSchema],
    ["teach-back decision", teachBackDecisionSchema],
    ["plan actions", planActionsSchema],
    ["import reading", importReadingSchema],
  ])("%s are accepted by strict structured outputs", (_, schema) => {
    expect(strictProblems(z.toJSONSchema(schema))).toEqual([]);
  });
});

describe("the plan's record", () => {
  it("places terms and adds notes, and can't rewrite the plan", () => {
    const parse = (action: object) => planActionsSchema.safeParse({ actions: [action] }).success;
    expect(parse({ type: "add-to-arc", arc: "Concurrency", terms: ["lock"] })).toBe(true);
    expect(parse({ type: "add-plan-notes", notes: "Backend first." })).toBe(true);
    expect(parse({ type: "set-plan", arcs: [], notes: "" })).toBe(false);
  });
});

describe("who may rewrite the plan", () => {
  const edit = { type: "edit-plan-notes", heading: "## Open threads", text: null };
  const arcsOnly = { type: "set-plan", arcs: [], notes: null };

  it("the close's sweep, by its arcs or by a section of the notes", () => {
    const parse = (action: object) => sweepActionsSchema.safeParse({ actions: [action] }).success;
    expect(parse(edit)).toBe(true);
    expect(parse(arcsOnly)).toBe(true);
  });

  it("no other call: the probe's decision, a check's verdict, or an edit asked for again", () => {
    for (const action of [edit, arcsOnly]) {
      expect(trackActionsSchema.safeParse({ actions: [action] }).success).toBe(false);
      expect(probeDecisionSchema.safeParse({ actions: [action], finished: false }).success).toBe(
        false,
      );
    }
  });
});
