import type { LanguageModelV4GenerateResult, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { LessonStep, TrackTerm } from "@grounded/content";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  generateLesson,
  placeChecks,
  type GenerateLessonOptions,
  type LessonOutline,
} from "./index.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const finish = { unified: "stop", raw: "stop" } as const;
const text = (value: string): LanguageModelV4GenerateResult => ({
  content: [{ type: "text", text: value }],
  finishReason: finish,
  usage,
  warnings: [],
});
const streamOf = (value: string, size = 17) => {
  const chunks: LanguageModelV4StreamPart[] = [{ type: "text-start", id: "t" }];
  for (let i = 0; i < value.length; i += size)
    chunks.push({ type: "text-delta", id: "t", delta: value.slice(i, i + size) });
  chunks.push({ type: "text-end", id: "t" }, { type: "finish", finishReason: finish, usage });
  return { stream: simulateReadableStream({ chunks }) };
};

const TERMS: TrackTerm[] = [
  { term: "memory", status: "confirmed" },
  { term: "working copy", status: "planned" },
  { term: "race condition", status: "planned" },
];

// s2 rests on what s1 teaches, so s1 ends with a check; nothing rests on s2, so its idea waits for
// the last check, at s3.
const OUTLINE: LessonOutline = {
  steps: [
    {
      heading: "Adding one is three moves",
      establishes: "copy, change, put back",
      introduces: ["working copy"],
      restsOn: ["memory"],
    },
    {
      heading: "Two workers",
      establishes: "interleaving loses an update",
      introduces: ["race condition"],
      restsOn: ["working copy"],
    },
    {
      heading: "An aside on speed",
      establishes: "it is rare",
      introduces: [],
      restsOn: ["memory"],
    },
  ],
};

/** The plain text of a call's prompt, across its messages. */
const promptText = (call: { prompt: unknown } | undefined) =>
  JSON.stringify(call?.prompt ?? [])
    .match(/"(?:text|content)":"((?:[^"\\]|\\.)*)"/g)
    ?.map((m) => JSON.parse(`{${m}}`) as Record<string, string>)
    .map((o) => Object.values(o).join(""))
    .join("\n") ?? "";

const step = (heading: string, body: string, check?: string) =>
  check ? `## ${heading}\n\n${body}\n\n:::check\n${check}\n:::` : `## ${heading}\n\n${body}`;
const S1 = step(
  "Adding one is three moves",
  "The value is copied out into a working copy.",
  "What is in memory meanwhile?",
);
const S2 = step("Two workers", "Both copy 5; this is a race condition.");
const S3 = step("An aside on speed", "It happens rarely.", "Why did the second worker's 6 win?");
const BROKEN_S1 = step("Adding one is three moves", "The value is copied out into a working copy.");

async function run(model: MockLanguageModelV4, options: Partial<GenerateLessonOptions> = {}) {
  const emitted: LessonStep[] = [];
  const result = await generateLesson({
    model,
    system: "SYSTEM",
    request: "Teach why counters lose updates.",
    terms: TERMS,
    onStep: (s) => {
      emitted.push(s);
    },
    ...options,
  });
  return { result, emitted };
}

describe("generateLesson", () => {
  it("outlines, streams the lesson and emits each step in order once it is sound", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [text(JSON.stringify(OUTLINE))],
      doStream: streamOf([S1, S2, S3].join("\n\n")),
    });
    const { result, emitted } = await run(model);

    expect(emitted.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(result.failed).toEqual([]);
    expect(result.steps.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(result.stepInfo).toEqual([
      { id: "s1", check: { steps: ["s1"], terms: ["working copy"], gates: true } },
      { id: "s2", check: null },
      { id: "s3", check: { steps: ["s2"], terms: ["race condition"], gates: false } },
    ]);
    const writing = promptText(model.doStreamCalls[0]);
    expect(writing).toContain(
      'it ends with a check: on "working copy" (taught in step 1), because the next step rests on it',
    );
    expect(writing).toContain("it ends without a check (nothing ahead rests on it yet");
    expect(writing).toContain(
      'on "race condition" (taught in step 2), because the lesson\'s last check, before the homework',
    );
  });

  it("reports each step as its writing starts, and each rewrite", async () => {
    const starts: [number, number, string[]][] = [];
    await generateLesson({
      model: new MockLanguageModelV4({
        doGenerate: [text(JSON.stringify(OUTLINE)), text(S1)],
        doStream: streamOf([BROKEN_S1, S2, S3].join("\n\n")),
      }),
      system: "SYSTEM",
      request: "Teach why counters lose updates.",
      terms: TERMS,
      onStep: () => undefined,
      onStepStart: (index, attempt, issues) => {
        starts.push([index, attempt, issues.map((i) => i.code)]);
      },
    });
    expect(starts).toEqual([
      [0, 0, []],
      [1, 0, []],
      [2, 0, []],
      [0, 1, ["lesson/missing-check"]],
    ]);
  });

  it("asks again for an outline that introduces a term outside the plan, saying why", async () => {
    const [first] = OUTLINE.steps;
    if (!first) throw new Error("fixture outline is empty");
    const bad: LessonOutline = { steps: [{ ...first, introduces: ["mutex"] }] };
    const model = new MockLanguageModelV4({
      doGenerate: [text(JSON.stringify(bad)), text(JSON.stringify(OUTLINE))],
      doStream: streamOf([S1, S2, S3].join("\n\n")),
    });
    const rejected: [number, number][] = [];
    const { emitted } = await run(model, {
      onOutlineRejected: (attempt, problems) => {
        rejected.push([attempt, problems]);
      },
    });

    expect(emitted).toHaveLength(3);
    expect(rejected).toEqual([[1, 1]]);
    expect(promptText(model.doGenerateCalls[1])).toContain(
      'Step 1 introduces "mutex", which isn\'t a planned term.',
    );
  });

  it("writes the rest of a lesson on its outline, after the steps already written", async () => {
    const model = new MockLanguageModelV4({ doStream: streamOf([S2, S3].join("\n\n")) });
    const starts: number[] = [];
    const { result, emitted } = await run(model, {
      resume: { outline: OUTLINE, written: [S1] },
      onOutline: () => {
        throw new Error("the outline is the one given");
      },
      onStepStart: (index) => {
        starts.push(index);
      },
    });

    expect(model.doGenerateCalls).toHaveLength(0);
    expect(emitted.map((s) => s.id)).toEqual(["s2", "s3"]);
    expect(starts).toEqual([1, 2]);
    expect(result.steps.map((s) => s.id)).toEqual(["s2", "s3"]);
    expect(result.stepInfo.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    const writing = promptText(model.doStreamCalls[0]);
    expect(writing).toContain("Its first step is written already:");
    expect(writing).toContain("The value is copied out into a working copy.");
    expect(writing).toContain("from step 2 to the end");
  });

  it("regenerates a broken step with its issues, keeping later steps behind it", async () => {
    const order: string[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: [text(JSON.stringify(OUTLINE)), text(S1)],
      doStream: streamOf([BROKEN_S1, S2, S3].join("\n\n")),
    });
    const result = await generateLesson({
      model,
      system: "SYSTEM",
      request: "Teach why counters lose updates.",
      terms: TERMS,
      onStep: (s) => {
        order.push(s.id);
      },
    });

    expect(order).toEqual(["s1", "s2", "s3"]);
    expect(result.steps[0]?.check?.children).toBeDefined();
    const regeneration = promptText(model.doGenerateCalls[1]);
    expect(regeneration).toContain(
      'This step must end with a :::check block: on "working copy" (taught in step 1), because the next step rests on it.',
    );
    expect(regeneration).toContain("Adding one is three moves");
  });

  it("rewrites a step that ends with a check where none was placed", async () => {
    const checkedS2 = step("Two workers", "Both copy 5; this is a race condition.", "Why 6?");
    const model = new MockLanguageModelV4({
      doGenerate: [text(JSON.stringify(OUTLINE)), text(S2)],
      doStream: streamOf([S1, checkedS2, S3].join("\n\n")),
    });
    const { result } = await run(model);

    expect(result.steps.map((s) => [s.id, s.check !== null])).toEqual([
      ["s1", true],
      ["s2", false],
      ["s3", true],
    ]);
    expect(promptText(model.doGenerateCalls[1])).toContain("Remove the :::check block.");
  });

  it("rejects a step that uses a term before it is introduced", async () => {
    const early = step(
      "Adding one is three moves",
      "A race condition starts here, with a working copy.",
      "What is in memory meanwhile?",
    );
    const model = new MockLanguageModelV4({
      doGenerate: [text(JSON.stringify(OUTLINE)), text(S1)],
      doStream: streamOf([early, S2, S3].join("\n\n")),
    });
    const { emitted } = await run(model);
    expect(emitted[0]?.id).toBe("s1");
    expect(promptText(model.doGenerateCalls[1])).toContain("race condition");
  });

  it("gives up on a step after two retries, reports it, and still emits the rest", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [text(JSON.stringify(OUTLINE)), text(BROKEN_S1), text(BROKEN_S1)],
      doStream: streamOf([BROKEN_S1, S2, S3].join("\n\n")),
    });
    const { result, emitted } = await run(model);

    expect(result.failed.map((f) => [f.stepId, f.issues.map((i) => i.code)])).toEqual([
      ["s1", ["lesson/missing-check"]],
    ]);
    expect(emitted.map((s) => s.id)).toEqual(["s2", "s3"]);
  });

  it("keeps a step whose only problem is a broken drawing, without the drawing, after retries", async () => {
    const withBadDiagram = step(
      "Adding one is three moves",
      "Copied into a working copy.\n\n```diagram\nno caption\n```",
      "What is in memory meanwhile?",
    );
    const model = new MockLanguageModelV4({
      doGenerate: [text(JSON.stringify(OUTLINE)), text(withBadDiagram), text(withBadDiagram)],
      doStream: streamOf([withBadDiagram, S2, S3].join("\n\n")),
    });
    const { result, emitted } = await run(model);

    expect(emitted.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(emitted[0]?.body.map((b) => b.type)).toEqual(["paragraph"]);
    expect(result.degraded.map((d) => [d.stepId, d.issues.map((i) => i.code)])).toEqual([
      ["s1", ["diagram/missing-separator"]],
    ]);
  });
});

describe("generateLesson: provider failures", () => {
  it("fails when the provider reports an error mid-stream, instead of ending quietly", async () => {
    const failure = new Error("upstream connection reset");
    const chunks: LanguageModelV4StreamPart[] = [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: S1 },
      { type: "error", error: failure },
    ];
    const model = new MockLanguageModelV4({
      doGenerate: [text(JSON.stringify(OUTLINE))],
      doStream: { stream: simulateReadableStream({ chunks }) },
    });
    await expect(run(model)).rejects.toThrow("upstream connection reset");
  });
});

describe("placeChecks", () => {
  const outline = (...steps: [string[], string[]][]): LessonOutline => ({
    steps: steps.map(([introduces, restsOn], i) => ({
      heading: `Step ${String(i + 1)}`,
      establishes: "",
      introduces,
      restsOn,
    })),
  });

  it("checks before the step that needs it, covering everything due however far back it was taught", () => {
    // The shape of a real first session on Ancient Egypt, which checked every one of its 7 steps.
    const placed = placeChecks(
      outline(
        [["BC dating"], []],
        [["Nile flood"], []],
        [["Upper and Lower Egypt"], ["Nile flood"]],
        [["unification"], ["BC dating", "Upper and Lower Egypt"]],
        [["maat"], ["pharaoh", "Nile flood"]],
        [["dynasty"], ["pharaoh", "unification"]],
        [["Old Kingdom"], ["BC dating", "unification", "dynasty", "maat"]],
      ),
    );
    expect(placed.map((s) => [s.id, s.check])).toEqual([
      ["s1", null],
      ["s2", { steps: ["s2"], terms: ["Nile flood"], gates: true }],
      ["s3", { steps: ["s1", "s3"], terms: ["BC dating", "Upper and Lower Egypt"], gates: true }],
      ["s4", null],
      ["s5", { steps: ["s4"], terms: ["unification"], gates: true }],
      ["s6", { steps: ["s5", "s6"], terms: ["dynasty", "maat"], gates: true }],
      ["s7", { steps: ["s7"], terms: ["Old Kingdom"], gates: false }],
    ]);
  });

  it("ends the lesson with a check on whatever no check has covered, for the homework", () => {
    const placed = placeChecks(outline([["a"], []], [["b"], []], [[], []]));
    expect(placed.map((s) => s.check)).toEqual([
      null,
      null,
      { steps: ["s1", "s2"], terms: ["a", "b"], gates: false },
    ]);
  });

  it("checks the last step's own idea when everything else is covered", () => {
    const placed = placeChecks(outline([["a"], []], [[], ["A"]]));
    expect(placed.map((s) => s.check)).toEqual([
      { steps: ["s1"], terms: ["a"], gates: true },
      { steps: ["s2"], terms: [], gates: false },
    ]);
  });

  it("checks a term once, and never on terms the learner already held", () => {
    const placed = placeChecks(outline([["a"], ["held"]], [[], ["a"]], [[], ["a", "held"]]));
    expect(placed.map((s) => s.check)).toEqual([
      { steps: ["s1"], terms: ["a"], gates: true },
      null,
      { steps: ["s3"], terms: [], gates: false },
    ]);
  });
});
