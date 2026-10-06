import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { parseBlocks, validate, type TrackTerm } from "@grounded/content";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { LEARNER_WORDS_LIMIT, learnerWords, reviewSystem, reviewWording } from "./review.js";

const reply = (value: object): LanguageModelV4GenerateResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  warnings: [],
});

const TERMS: TrackTerm[] = [
  { term: "memory", status: "confirmed" },
  { term: "lost update", status: "planned" },
];

/** A text as a surface's validation sees it: the ambiguous words it flags for review. */
const unit = (markdown: string) => {
  const issues = validate(parseBlocks(markdown).blocks, { surface: "chat", terms: TERMS });
  return { markdown, flagged: issues.filter((i) => i.severity === "review"), terms: TERMS };
};

const LONG =
  "Before we go on, let me check one thing about how you picture it: when two workers each copy the number out of memory, what do they each hold, and where is the map of what they hold?";

describe("the wording review", () => {
  it("turns what the model judged into issues to fix: machinery in context, and unheld jargon", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        reply({
          flagged: [
            { word: "map", machinery: true },
            { word: "copy", machinery: true },
          ],
          jargon: [{ word: "mutex", plain: "a lock only one worker holds at a time" }],
        }),
      ],
    });
    const issues = await reviewWording(model, unit(LONG));
    expect(issues).toEqual([
      {
        code: "scaffolding/judged",
        message:
          '"map" reads as the tutor\'s own bookkeeping here; the learner never sees it. Say what a tutor would say instead.',
        blockId: "b1",
      },
      {
        code: "term/judged",
        message:
          '"mutex" is used as if the learner knew it, and they don\'t; say it in plain words (a lock only one worker holds at a time), or explain it right where it is used.',
      },
    ]);
    // It is asked about the flagged words, with what the learner holds and doesn't.
    const call = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(call).toContain('Words to judge: \\"map\\"');
    expect(call).toContain("Terms the learner holds: memory");
    expect(call).toContain("Terms of the subject the learner doesn't hold yet: lost update");
  });

  it("judges a probe question for machinery only: what it names is not jargon", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        reply({
          flagged: [{ word: "map", machinery: true }],
          jargon: [
            { word: "Kubernetes", plain: "a system that runs packaged apps across servers" },
          ],
        }),
      ],
    });
    const question = `${LONG} Have you used Docker or Kubernetes for that?`;
    const issues = await reviewWording(model, { ...unit(question), probe: true });
    expect(issues.map((i) => i.code)).toEqual(["scaffolding/judged"]);
    const call = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(call).toContain("This text is a probe question");
    expect(call).toContain("list no jargon");
  });

  it("makes no call for a probe question with no word to judge, however long", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [] });
    const question =
      "Have you used Docker or Kubernetes, or anything else that packages an app with what it needs and runs it the same way on every machine? If so, what for, and where did it get in your way?";
    expect(await reviewWording(model, { ...unit(question), probe: true })).toEqual([]);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("finds nothing where the model judged the words everyday ones", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [reply({ flagged: [{ word: "map", machinery: false }], jargon: [] })],
    });
    expect(await reviewWording(model, unit(LONG))).toEqual([]);
  });

  it("makes no call for a short text with nothing to judge", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [] });
    expect(await reviewWording(model, unit("That's it: memory still holds 5."))).toEqual([]);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("reads what the learner has said, so a word their background covers isn't jargon", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [reply({ flagged: [], jargon: [] })] });
    await reviewWording(model, unit(LONG), {
      goal: "Prepare for a senior front-end interview",
      brief: null,
      about: "Backend developer by day; Node and Postgres.",
      said: ["I've shipped React apps for six years."],
    });
    const call = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(call).toContain(
      "What the learner wrote they want to learn: Prepare for a senior front-end interview",
    );
    expect(call).toContain("- I've shipped React apps for six years.");
    expect(call).toContain(
      "What the learner wrote about themselves: Backend developer by day; Node and Postgres.",
    );
    expect(call).toContain("Judge against this learner, not a newcomer.");
  });

  it("keeps the learner's newest words when they have said a lot", () => {
    const old = "o".repeat(LEARNER_WORDS_LIMIT);
    const text = learnerWords({
      goal: "Geometry",
      brief: "A syllabus.",
      about: null,
      said: [old, "newest"],
    });
    expect(text).toContain("What they brought, summarized: A syllabus.");
    expect(text).toContain("- newest");
    expect(text).not.toContain(old);
  });

  it("counts what the surroundings introduced as held", () => {
    const system = reviewSystem(TERMS, ["lost update"]);
    expect(system).toContain("Terms the learner holds: memory · lost update");
    expect(system).toContain("doesn't hold yet: none");
  });
});
