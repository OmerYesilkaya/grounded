import type { LanguageModelV4GenerateResult, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { Issue, LessonStep, TrackTerm } from "@grounded/content";
import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  generateLesson,
  LessonOutlineError,
  placeChecks,
  type CallTracer,
  type CallVerdict,
  type GenerateLessonOptions,
  type LessonMedia,
  type LessonOutline,
} from "./index.js";
import { fitOutline } from "./lesson.js";

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
  title: "Why two writers lose an update",
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
const WORKING_COPY =
  'The value is copied out, changed, and put back.\n\n:::word{term="working copy"}\nThe copy of a value that is changed before it is put back.\n:::\n\nThe working copy holds 5.';
const S1 = step("Adding one is three moves", WORKING_COPY, "What is in memory meanwhile?");
const S2 = step(
  "Two workers",
  'Both copy 5, and one update is lost.\n\n:::word{term="race condition"}\nWhen the result depends on which worker goes first.\n:::',
);
const S3 = step("An aside on speed", "It happens rarely.", "Why did the second worker's 6 win?");
const BROKEN_S1 = step("Adding one is three moves", WORKING_COPY);

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

  it("rewrites a step that uses its new word before giving it a word card", async () => {
    const uncarded = step(
      "Adding one is three moves",
      "The value is copied out into a working copy.",
      "What is in memory meanwhile?",
    );
    const model = new MockLanguageModelV4({
      doGenerate: [text(JSON.stringify(OUTLINE)), text(S1)],
      doStream: streamOf([uncarded, S2, S3].join("\n\n")),
    });
    const { emitted } = await run(model);
    expect(emitted.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    const rewrite = promptText(model.doGenerateCalls[1]);
    expect(rewrite).toContain('"working copy" is used before its word card.');
    expect(rewrite).toContain('give it a word card (:::word{term="working copy"})');
    // The writer is told which words each step gives a card.
    expect(promptText(model.doStreamCalls[0])).toContain(
      "introduces working copy (each on its word card before it is used)",
    );
  });

  it("rewrites a sound step the review objects to, and keeps it as written if it still does", async () => {
    const JARGON: Issue = {
      code: "term/judged",
      message: '"mutex" is used as if the learner knew it.',
    };
    const reviewed: string[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: [text(JSON.stringify(OUTLINE)), text(S1), text(S1)],
      doStream: streamOf([S1, S2, S3].join("\n\n")),
    });
    const { result, emitted } = await run(model, {
      // Step 1 is always judged; the others never are.
      review: (unit) => {
        reviewed.push(unit.introduced?.join(" · ") ?? "");
        return Promise.resolve(unit.markdown.startsWith("## Adding one") ? [JARGON] : []);
      },
    });
    expect(emitted.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(result.failed).toEqual([]);
    expect(result.degraded).toEqual([{ stepId: "s1", issues: [JARGON] }]);
    expect(promptText(model.doGenerateCalls[1])).toContain(
      '"mutex" is used as if the learner knew it.',
    );
    // Each step is judged with the words given so far, its own cards included.
    expect(reviewed).toContain("working copy · race condition");
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
    const bad: LessonOutline = { ...OUTLINE, steps: [{ ...first, introduces: ["mutex"] }] };
    const model = new MockLanguageModelV4({
      doGenerate: [text(JSON.stringify(bad)), text(JSON.stringify(OUTLINE))],
      doStream: streamOf([S1, S2, S3].join("\n\n")),
    });
    const rejected: [number, string[]][] = [];
    const { emitted } = await run(model, {
      onOutlineRejected: (attempt, problems) => {
        rejected.push([attempt, problems.map((p) => p.code)]);
      },
    });

    expect(emitted).toHaveLength(3);
    expect(rejected).toEqual([[1, ["outline/not-planned"]]]);
    expect(promptText(model.doGenerateCalls[1])).toContain(
      'Step 1 introduces "mutex", which isn\'t a planned term. Name the planned term it teaches exactly as the term list spells it, or leave it out.',
    );
  });

  it("gives each call its verdict: each outline's problems, the stream's by step, each rewrite's", async () => {
    const [first] = OUTLINE.steps;
    if (!first) throw new Error("fixture outline is empty");
    const bad: LessonOutline = { ...OUTLINE, steps: [{ ...first, introduces: ["mutex"] }] };
    const model = new MockLanguageModelV4({
      doGenerate: [text(JSON.stringify(bad)), text(JSON.stringify(OUTLINE)), text(S1)],
      doStream: streamOf([BROKEN_S1, S2, S3].join("\n\n")),
    });
    // One entry per traced call, in the order they were made, with the verdicts it was given.
    const calls: CallVerdict[][] = [];
    const trace: CallTracer = async (call) => {
      const verdicts: CallVerdict[] = [];
      calls.push(verdicts);
      return {
        value: await call(),
        judge: (verdict) => {
          verdicts.push(verdict);
          return Promise.resolve();
        },
      };
    };
    await run(model, { trace });

    const brief = (verdicts: CallVerdict[]) =>
      verdicts.map((v) => [v.rewrite, v.issues.map((i) => `${i.stepId ?? ""} ${i.code ?? ""}`)]);
    expect(calls.map(brief)).toEqual([
      [[0, ["s1 outline/not-planned"]]],
      [[1, []]],
      // The stream wrote every step; only the first broke a rule.
      [[0, ["s1 lesson/missing-check"]]],
      [[1, []]],
    ]);
  });

  it("gives up after three outlines that don't fit, with what was wrong with the last", async () => {
    const [first] = OUTLINE.steps;
    if (!first) throw new Error("fixture outline is empty");
    // Rests on a planned term nothing before it introduces, every time.
    const bad = JSON.stringify({ ...OUTLINE, steps: [{ ...first, restsOn: ["race condition"] }] });
    const model = new MockLanguageModelV4({ doGenerate: [text(bad), text(bad), text(bad)] });
    const rejected: number[] = [];
    const failure = run(model, {
      onOutlineRejected: (attempt) => {
        rejected.push(attempt);
      },
    });

    await expect(failure).rejects.toBeInstanceOf(LessonOutlineError);
    await expect(failure).rejects.toMatchObject({
      problems: [
        {
          code: "outline/not-held",
          step: 1,
          message:
            "Step 1 rests on \"race condition\", which the learner doesn't have yet (planned): introduce it in this step or an earlier one, or don't rest on it.",
        },
      ],
    });
    expect(rejected).toEqual([1, 2]);
    expect(model.doGenerateCalls).toHaveLength(3);
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
    expect(writing).toContain("The working copy holds 5.");
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
      `${WORKING_COPY}\n\n` + "```diagram\nno caption\n```",
      "What is in memory meanwhile?",
    );
    const model = new MockLanguageModelV4({
      doGenerate: [text(JSON.stringify(OUTLINE)), text(withBadDiagram), text(withBadDiagram)],
      doStream: streamOf([withBadDiagram, S2, S3].join("\n\n")),
    });
    const { result, emitted } = await run(model);

    expect(emitted.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(emitted[0]?.body.map((b) => b.type)).toEqual(["paragraph", "word", "paragraph"]);
    expect(result.degraded.map((d) => [d.stepId, d.issues.map((i) => i.code)])).toEqual([
      ["s1", ["diagram/missing-separator"]],
    ]);
  });
});

describe("generateLesson: media", () => {
  const IMAGE = '::image{ref="commons:File:Counter.png" caption="A counter."}';
  const withImage = step(
    "Adding one is three moves",
    `${WORKING_COPY}\n\n${IMAGE}`,
    "What is in memory meanwhile?",
  );
  /** Media whose verifier finds nothing on Commons, and records what it was asked. */
  const media = (searched: string[] = []): LessonMedia & { verified: string[] } => {
    const verified: string[] = [];
    return {
      verified,
      tools: {
        find_image: tool({
          inputSchema: z.object({ query: z.string() }),
          execute: ({ query }) => {
            searched.push(query);
            return { files: [] };
          },
        }),
      },
      found: () => (searched.length ? "FOUND ON COMMONS" : ""),
      verify: (s) => {
        verified.push(s.id);
        const body = s.body.filter((b) => b.type !== "image");
        const issues: Issue[] =
          body.length < s.body.length
            ? [{ code: "image/unverified", message: "No such file.", stepId: s.id }]
            : [];
        return Promise.resolve({ step: { ...s, body }, issues });
      },
    };
  };

  it("offers the tools to the outline only, and tells the writer what they found", async () => {
    const toolCall: LanguageModelV4GenerateResult = {
      content: [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "find_image",
          input: JSON.stringify({ query: "a mechanical counter" }),
        },
      ],
      finishReason: { unified: "tool-calls", raw: "tool_use" },
      usage,
      warnings: [],
    };
    const model = new MockLanguageModelV4({
      doGenerate: [toolCall, text(JSON.stringify(OUTLINE))],
      doStream: streamOf([S1, S2, S3].join("\n\n")),
    });
    const searched: string[] = [];
    const lessonMedia = media(searched);
    const { result } = await run(model, { media: lessonMedia });

    expect(searched).toEqual(["a mechanical counter"]);
    expect(model.doGenerateCalls[0]?.tools?.map((t) => t.name)).toEqual(["find_image"]);
    expect(promptText(model.doGenerateCalls[0])).toContain("find_image or find_audio");
    expect(model.doStreamCalls[0]?.tools).toBeUndefined();
    expect(promptText(model.doStreamCalls[0])).toContain("FOUND ON COMMONS");
    expect(lessonMedia.verified).toEqual(["s1", "s2", "s3"]);
    expect(result.steps.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("rewrites a step whose media can't be verified, and keeps it without it after retries", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [text(JSON.stringify(OUTLINE)), text(withImage), text(withImage)],
      doStream: streamOf([withImage, S2, S3].join("\n\n")),
    });
    const { result, emitted } = await run(model, { media: media() });

    expect(promptText(model.doGenerateCalls[1])).toContain("No such file.");
    expect(emitted.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(emitted[0]?.body.map((b) => b.type)).toEqual(["paragraph", "word", "paragraph"]);
    expect(result.degraded.map((d) => [d.stepId, d.issues.map((i) => i.code)])).toEqual([
      ["s1", ["image/unverified"]],
    ]);
  });

  it("keeps the verified step once a rewrite's media checks out", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [text(JSON.stringify(OUTLINE)), text(S1)],
      doStream: streamOf([withImage, S2, S3].join("\n\n")),
    });
    const { result, emitted } = await run(model, { media: media() });

    expect(emitted.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(result.degraded).toEqual([]);
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
    title: "A lesson",
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

describe("fitOutline", () => {
  const outline = (...steps: [string[], string[]][]): LessonOutline => ({
    title: "A lesson",
    steps: steps.map(([introduces, restsOn], i) => ({
      heading: `Step ${String(i + 1)}`,
      establishes: "",
      introduces,
      restsOn,
    })),
  });

  // Names as a track imported from long notes has them (Omer's "How software works").
  const LONG: TrackTerm[] = [
    {
      term: "index; B-tree (pages of ranges → leaf pages of keys → row location); measured 4 levels at 10M",
      status: "confirmed",
    },
    {
      term: "requests table row: one API request with api_key_id, tokens, and created_at",
      status: "planned",
    },
    { term: "GROUP BY", status: "planned" },
    { term: "ORDER BY aggregate and LIMIT", status: "planned" },
  ];

  it("reads a long term by a part of its name, and writes it as the term list spells it", () => {
    const fitted = fitOutline(
      outline(
        [["requests table row"], []],
        [["group by"], ["requests table row", "index", "B-tree"]],
      ),
      LONG,
    );
    expect(fitted.problems).toEqual([]);
    expect(fitted.outline.steps.map((s) => [s.introduces, s.restsOn])).toEqual([
      [[LONG[1]?.term], []],
      [["GROUP BY"], [LONG[1]?.term, LONG[0]?.term]],
    ]);
  });

  it("reads a part of a name only when it names one term", () => {
    const terms: TrackTerm[] = [
      { term: "latency: RAM", status: "planned" },
      { term: "latency: disk", status: "planned" },
    ];
    const fitted = fitOutline(outline([["latency"], []]), terms);
    expect(fitted.problems.map((p) => p.code)).toEqual(["outline/not-planned"]);
    // What it most likely meant is named, so the next outline can spell it.
    expect(fitted.problems[0]?.message).toContain('(perhaps "latency: RAM" or "latency: disk")');
  });

  it("moves a held term named as introduced to what the step rests on", () => {
    const fitted = fitOutline(outline([["index", "GROUP BY"], []]), LONG);
    expect(fitted.problems).toEqual([]);
    expect(fitted.outline.steps[0]).toMatchObject({
      introduces: ["GROUP BY"],
      restsOn: [LONG[0]?.term],
    });
  });

  it("keeps a rest-on the term list doesn't have: nothing says whether the learner holds it", () => {
    const fitted = fitOutline(outline([[], ["One row records one API request"]]), LONG);
    expect(fitted.problems).toEqual([]);
    expect(fitted.outline.steps[0]?.restsOn).toEqual(["One row records one API request"]);
  });

  it("finds a term by a fragment of its name, by its name run on, and in two names copied as one", () => {
    const fitted = fitOutline(
      outline(
        [["requests table row: one API request"], ["B-tree (pages of ranges → leaf pages"]],
        [["GROUP BY, then SUM"], []],
        [["ORDER BY aggregate and LIMIT · GROUP BY"], []],
      ),
      LONG,
    );
    expect(fitted.problems).toEqual([]);
    expect(fitted.outline.steps.map((s) => [s.introduces, s.restsOn])).toEqual([
      [[LONG[1]?.term], [LONG[0]?.term]],
      [["GROUP BY"], []],
      [["ORDER BY aggregate and LIMIT", "GROUP BY"], []],
    ]);
  });

  it("teaches a taught term again where a step first rests on it", () => {
    const shaky: TrackTerm[] = [...LONG, { term: "SUM", status: "taught" }];
    const fitted = fitOutline(outline([[], ["SUM"]], [[], ["SUM"]]), shaky);
    expect(fitted.problems).toEqual([]);
    expect(fitted.outline.steps.map((s) => [s.introduces, s.restsOn])).toEqual([
      [["SUM"], ["SUM"]],
      [[], ["SUM"]],
    ]);
  });

  it("rejects resting on a planned term before the step that introduces it", () => {
    const fitted = fitOutline(outline([[], ["GROUP BY"]], [["GROUP BY"], ["GROUP BY"]]), LONG);
    expect(fitted.problems.map((p) => [p.code, p.step])).toEqual([["outline/not-held", 1]]);
  });
});
