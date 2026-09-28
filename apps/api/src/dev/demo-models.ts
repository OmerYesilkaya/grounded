import type { LanguageModelV4GenerateResult, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { ModelAccess } from "../engine/model-call.js";

/**
 * Development only (DEMO_MODELS=true): canned model responses that walk through one session, so the
 * UI can be worked on without spending anyone's credit. Not a teaching model.
 */
const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function model(text: string, generate: string[] = []) {
  const parts: LanguageModelV4StreamPart[] = [{ type: "text-start", id: "t" }];
  for (const word of text.split(/(?<=\s)/))
    parts.push({ type: "text-delta", id: "t", delta: word });
  parts.push({ type: "text-end", id: "t" });
  parts.push({
    type: "finish",
    finishReason: { unified: "stop", raw: "stop" },
    usage,
  });
  const result = (t: string): LanguageModelV4GenerateResult => ({
    content: [{ type: "text", text: t }],
    finishReason: { unified: "stop", raw: "stop" },
    usage,
    warnings: [],
  });
  return new MockLanguageModelV4({
    doStream: { stream: simulateReadableStream({ chunks: parts, chunkDelayInMs: 18 }) },
    doGenerate: generate.length ? generate.map(result) : [result(text)],
  });
}

const step = (heading: string, body: string, check: string) =>
  `## ${heading}\n\n${body}\n\n:::check\n${check}\n:::`;
const LESSON = [
  step(
    "Adding one is three moves",
    'You told me the computer “just adds one”. That\'s true, and it hides something: the number lives in memory, and the part that does arithmetic can\'t change a value where it sits.\n\nSo it copies the value out into a working copy, changes the copy, and puts it back.\n\n```diagram\ncaption: Adding one takes three separate moves.\nhighlight: C\n---\nflowchart TB\n  M[("memory: 5")] -->|copy out| R["working copy: 5"]\n  R -->|change| C["working copy: 6"]\n  C -->|put back| M2[("memory: 6")]\n```',
    "In one sentence: what is in memory while the working copy is being changed?",
  ),
  step(
    "Two workers, one number",
    "Now two workers do the same job at once. Each does its own three moves, and nothing keeps one worker's moves together.\n\nIf both copy 5 before either puts its copy back, both put back 6. Two additions happened; the number went up by one. That missing addition has a name: a lost update.",
    "In one sentence: why did the number end at 6 instead of 7?",
  ),
  step(
    "Why it hides",
    "It only happens when the moves interleave in just that way, so it can hide for months and then appear once.",
    "In one sentence: why can it hide for months?",
  ),
].join("\n\n");
const OUTLINE = {
  steps: [
    {
      heading: "Adding one is three moves",
      establishes: "copy, change, put back",
      introduces: ["working copy"],
      restsOn: [],
    },
    {
      heading: "Two workers, one number",
      establishes: "interleaving loses an update",
      introduces: ["lost update"],
      restsOn: ["working copy"],
    },
    {
      heading: "Why it hides",
      establishes: "it needs bad timing",
      introduces: [],
      restsOn: ["lost update"],
    },
  ],
};

export function createDemoModels(): ModelAccess {
  const counts = new Map<string, number>();
  const next = (purpose: string) => {
    const n = (counts.get(purpose) ?? 0) + 1;
    counts.set(purpose, n);
    return n;
  };
  const make: Record<string, (n: number) => MockLanguageModelV4> = {
    // The opening question, then (after the learner's answer) the decision that the probe is done,
    // which comes first and leaves no probe message to write.
    probe: () =>
      model("In your own words: what do you think happens when a program adds one to a number?"),
    "probe-decision": () =>
      model("", [
        JSON.stringify({
          actions: [{ type: "add-fix-item", text: "Thinks adding one is a single step" }],
          finished: true,
        }),
      ]),
    "probe-summary": () =>
      model(
        "Knows a program changes values in memory; thinks adding one is a single step. Goal: understand why a shared counter ends up too low.",
      ),
    plan: () =>
      model(
        "We start from something you already hold: a program changes values in memory. From there we'll see what really happens when a number goes up by one, then what goes wrong when two parts of a program do it at the same moment. That is exactly the counter problem you described.",
        [
          JSON.stringify({
            actions: [
              { type: "add-planned-term", term: "working copy", restsOn: [] },
              { type: "add-planned-term", term: "lost update", restsOn: ["working copy"] },
              { type: "add-to-arc", arc: "Concurrency", terms: ["working copy", "lost update"] },
            ],
          }),
        ],
      ),
    lesson: () => model(LESSON, [JSON.stringify(OUTLINE)]),
    check: (n) =>
      model("", [
        JSON.stringify(
          n === 2
            ? {
                verdict: "missed",
                reply:
                  "Close, but that says what happened, not why. Worker B copied the value out **before** worker A put its 6 back, so B added one to an old 5.",
                freshQuestion:
                  "Two workers each take one away from a balance of 10 at the same time. What is the worst final value, and why?",
                note: "The second worker copied the value out before the first put its result back, so it worked from an old copy.",
                actions: [],
              }
            : {
                verdict: "landed",
                reply: "That's it.",
                freshQuestion: null,
                note: null,
                actions: [],
              },
        ),
      ]),
    homework: () =>
      model(
        "**Predict, then check.** Two workers each add one to a counter that starts at 0, a thousand times each. Write down what you expect the counter to show, then run it and explain any difference.\n\nA good answer shows why the three moves can interleave.",
      ),
    close: () =>
      model(
        "We started from memory holding one value at a time, saw that adding one is really three moves, and that two workers' moves can interleave and lose an update.",
      ),
    "track-name": () => model("", [JSON.stringify({ name: "Demo track" })]),
    "track-brief": () => model("The demo doesn't read files; this stands in for their summary."),
    "term-sweep": () =>
      model("", [
        JSON.stringify({
          actions: [
            {
              type: "set-term-status",
              term: "working copy",
              status: "confirmed",
              evidence: "memory still holds the old value",
            },
          ],
        }),
      ]),
  };
  return {
    model: ({ purpose }) => {
      const build = make[purpose];
      if (!build) return Promise.reject(new Error(`the demo has no responses for "${purpose}"`));
      return Promise.resolve(build(next(purpose)));
    },
    searchTool: () => Promise.resolve(undefined),
  };
}
