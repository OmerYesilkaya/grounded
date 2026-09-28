import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  checkVerdictSchema,
  importReadingSchema,
  lessonOutlineSchema,
  planActionsSchema,
  probeDecisionSchema,
  trackActionSchema,
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
    ["track actions", z.object({ actions: z.array(trackActionSchema) })],
    ["check verdict", checkVerdictSchema],
    ["lesson outline", lessonOutlineSchema],
    ["probe decision", probeDecisionSchema],
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
