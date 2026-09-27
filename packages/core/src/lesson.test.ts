import type { LanguageModelV4GenerateResult, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { LessonStep, TrackTerm } from "@grounded/content";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { generateLesson, type LessonOutline } from "./index.js";

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

const OUTLINE: LessonOutline = {
  steps: [
    {
      heading: "Adding one is three moves",
      establishes: "copy, change, put back",
      introduces: ["working copy"],
      restsOn: ["memory"],
      check: "What is in memory meanwhile?",
    },
    {
      heading: "Two workers",
      establishes: "interleaving loses an update",
      introduces: ["race condition"],
      restsOn: ["working copy"],
      check: "Why 6 and not 7?",
    },
    {
      heading: "An aside on speed",
      establishes: "it is rare",
      introduces: [],
      restsOn: ["memory"],
      check: "Why can it hide for months?",
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

const step = (heading: string, body: string, check: string) =>
  `## ${heading}\n\n${body}\n\n:::check\n${check}\n:::`;
const S1 = step(
  "Adding one is three moves",
  "The value is copied out into a working copy.",
  "What is in memory meanwhile?",
);
const S2 = step("Two workers", "Both copy 5; this is a race condition.", "Why 6 and not 7?");
const S3 = step("An aside on speed", "It happens rarely.", "Why can it hide for months?");

async function run(model: MockLanguageModelV4) {
  const emitted: LessonStep[] = [];
  const result = await generateLesson({
    model,
    system: "SYSTEM",
    request: "Teach why counters lose updates.",
    terms: TERMS,
    onStep: (s) => {
      emitted.push(s);
    },
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
    // s2 uses the term s1 introduces; s3 uses only what the learner already had.
    expect(result.stepInfo).toEqual([
      { id: "s1", restsOnPrevious: false },
      { id: "s2", restsOnPrevious: true },
      { id: "s3", restsOnPrevious: false },
    ]);
    expect(promptText(model.doStreamCalls[0])).toContain("Adding one is three moves");
  });

  it("reports each step as its writing starts, and each rewrite", async () => {
    const brokenS2 = "## Two workers\n\nBoth copy 5; this is a race condition.";
    const starts: [number, number][] = [];
    await generateLesson({
      model: new MockLanguageModelV4({
        doGenerate: [text(JSON.stringify(OUTLINE)), text(S2)],
        doStream: streamOf([S1, brokenS2, S3].join("\n\n")),
      }),
      system: "SYSTEM",
      request: "Teach why counters lose updates.",
      terms: TERMS,
      onStep: () => undefined,
      onStepStart: (index, attempt) => {
        starts.push([index, attempt]);
      },
    });
    expect(starts).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [1, 1],
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
    const { emitted } = await run(model);

    expect(emitted).toHaveLength(3);
    expect(promptText(model.doGenerateCalls[1])).toContain(
      'Step 1 introduces "mutex", which isn\'t a planned term.',
    );
  });

  it("regenerates a broken step with its issues, keeping later steps behind it", async () => {
    const brokenS2 = "## Two workers\n\nBoth copy 5; this is a race condition.";
    const order: string[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: [text(JSON.stringify(OUTLINE)), text(S2)],
      doStream: streamOf([S1, brokenS2, S3].join("\n\n")),
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
    expect(result.steps[1]?.check.children).toBeDefined();
    const regeneration = promptText(model.doGenerateCalls[1]);
    expect(regeneration).toContain('Step "Two workers" must end with exactly one :::check block.');
    expect(regeneration).toContain("Two workers");
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
    const broken = "## Two workers\n\nNo check here.";
    const model = new MockLanguageModelV4({
      doGenerate: [text(JSON.stringify(OUTLINE)), text(broken), text(broken)],
      doStream: streamOf([S1, broken, S3].join("\n\n")),
    });
    const { result, emitted } = await run(model);

    expect(result.failed.map((f) => [f.stepId, f.issues.map((i) => i.code)])).toEqual([
      ["s2", ["lesson/missing-check"]],
    ]);
    expect(emitted.map((s) => s.id)).toEqual(["s1", "s3"]);
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
