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
    'You told me the computer “just adds one”. That\'s true, and it hides something: the number lives in memory, and the part that does arithmetic can\'t change a value where it sits.\n\nSo it copies the value out, changes the copy, and puts it back.\n\n:::word{term="working copy"}\nThe copy of a value that is taken out to be changed, before it is put back.\n:::\n\n```diagram\ncaption: Adding one takes three separate moves.\nhighlight: C\n---\nflowchart TB\n  M[("memory: 5")] -->|copy out| R["working copy: 5"]\n  R -->|change| C["working copy: 6"]\n  C -->|put back| M2[("memory: 6")]\n```',
    "In one sentence: what is in memory while the working copy is being changed?",
  ),
  step(
    "Two workers, one number",
    'Now two workers do the same job at once. Each does its own three moves, and nothing keeps one worker\'s moves together.\n\nIf both copy 5 before either puts its copy back, both put back 6. Two additions happened; the number went up by one. That missing addition is common enough to have a name.\n\n:::word{term="lost update"}\nAn addition that vanishes because another worker put its copy back over it.\n:::',
    "In one sentence: why did the number end at 6 instead of 7?",
  ),
  step(
    "Why it hides",
    "It only happens when the moves interleave in just that way, so it can hide for months and then appear once.",
    "In one sentence: why can it hide for months?",
  ),
].join("\n\n");
const OUTLINE = {
  title: "Why two writers lose an update",
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
    "probe-verdict": () =>
      model(
        JSON.stringify({
          strands: [
            {
              name: "What a program does to a number",
              band: "solid",
              text: "You said plainly that a program changes values in memory, and used that with confidence.",
            },
            {
              name: "Adding one",
              band: "working",
              text: "You treated adding one as a single move. That's where it got shaky, and where the lesson starts.",
            },
          ],
          overall: {
            band: "working",
            text: "You have firm ground to build on. The way to seeing why a shared counter ends up too low starts right where your answers got shaky.",
          },
        }),
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
                alreadyHeld: null,
                note: "The second worker copied the value out before the first put its result back, so it worked from an old copy.",
                actions: [],
              }
            : {
                verdict: "landed",
                reply: "That's it.",
                freshQuestion: null,
                alreadyHeld: null,
                note: null,
                actions: [],
              },
        ),
      ]),
    homework: () =>
      model(
        "Two workers each add one to a counter that starts at 0, a thousand times each, at the same time. Here is the program:\n\n```python\nimport threading\n\ncounter = 0\n\ndef work():\n    global counter\n    for _ in range(1000):\n        value = counter\n        counter = value + 1\n\nworkers = [threading.Thread(target=work) for _ in range(2)]\nfor w in workers:\n    w.start()\nfor w in workers:\n    w.join()\nprint(counter)\n```\n\n**Predict** what it prints, and why. Then run it a few times and compare.",
        [
          JSON.stringify({
            title: "Two workers, one counter",
            forms: ["predict"],
            checklist: [
              "Says which three moves adding one takes",
              "Shows how two workers' moves can interleave",
              "Explains why the result changes from run to run",
            ],
          }),
        ],
      ),
    // The first session's recap; after it, the final's (the demo's plan is one session long).
    close: (n) =>
      model(
        n === 1
          ? "We started from memory holding one value at a time, saw that adding one is really three moves, and that two workers' moves can interleave and lose an update."
          : "When you started, you thought adding one was a single step; that is gone, and you rebuilt the three moves and the lost update from memory holding one value at a time. One new thing came up: you expect a lock to make the work itself faster, when all it does is make one worker wait for the other.\n\nThe chain broke once. You said the arithmetic part needs a copy because *that's how computers work*; what it rests on is that the part doing the arithmetic can only work on values it holds, not on memory where they sit. That link, and the lock, are what a next session would take up.",
      ),
    // The final (design §7.4): two audit questions, the second answer ending the audit, then a
    // teach-back of three turns whose second answer breaks the chain.
    audit: (n) =>
      model(
        n === 1
          ? "To start: a program adds one to a number in memory. In your own words, what actually happens?"
          : "Two workers share a counter, and someone suggests putting a lock around the addition. What does the lock change, and what does it cost?",
      ),
    "audit-decision": (n) =>
      model("", [
        JSON.stringify({
          actions:
            n === 2
              ? [{ type: "add-fix-item", text: "Expects a lock to make the work itself faster" }]
              : [],
          finished: n % 2 === 0,
        }),
      ]),
    "teach-back": (n) =>
      model(
        [
          "Thanks. Now the teach-back: rebuild the whole thing for me from its foundations, in your own words, as if I wasn't there. Start wherever you think it starts; I'll keep asking why, and what if.",
          "Why can't the part doing the arithmetic just change the number where it sits?",
          "And what if the two workers ran on a single core, taking turns: could an update still be lost?",
        ][(n - 1) % 3] ?? "",
      ),
    "teach-back-decision": (n) =>
      model("", [
        JSON.stringify({
          actions: [],
          breaks:
            n % 3 === 2
              ? [{ term: "working copy", quote: "because that's how computers work, it just is" }]
              : [],
          finished: n % 3 === 0,
        }),
      ]),
    // Every second question in the margin opens a tangent, which the card offers to save.
    aside: (n) =>
      model(
        n % 2 === 1
          ? "The number itself never moves: it stays in memory the whole time. What changes is a **copy** of it, held by the part that does the arithmetic, and only the last move puts the new value back."
          : "Yes, and it isn't only a problem for programs on one machine: databases meet it all the time, with many people changing the same row. That's a story of its own; we can save it for a future session.",
      ),
    "aside-record": (n) =>
      model("", [
        JSON.stringify({
          evidence: [],
          tangent: n % 2 === 1 ? null : "How databases keep updates from getting lost",
        }),
      ]),
    // The homework's review: a comment on the prediction's "2000" (on the whole prediction if the
    // answer doesn't say it), one on the reconciling as a whole, and each item marked.
    review: () =>
      model("", [
        JSON.stringify({
          comments: [
            {
              task: "t1",
              field: "prediction",
              quote: "2000",
              items: ["c2"],
              comment:
                "You expected every addition to count. Look at the two lines inside the loop: what can the other worker do between `value = counter` and `counter = value + 1`?",
            },
            {
              task: "t1",
              field: "reconcile",
              quote: "",
              items: ["c3"],
              comment:
                "You saw the number change from run to run. What decides how often the two workers' moves overlap?",
            },
          ],
          checklist: [
            { item: "c1", mark: "held", note: "You name copying out, adding and putting back." },
            { item: "c2", mark: "leaked", note: "Look again at what happens inside the loop." },
            {
              item: "c3",
              mark: "missing",
              note: "What would make one run lose more than another?",
            },
          ],
          actions: [],
        }),
      ]),
    // A reply in a comment's card: the first one gets another question, the second finds the flaw.
    "review-reply": (n) =>
      model(
        n % 2 === 1
          ? "Closer. And once both workers have read the same number, what does each of them write back?"
          : "That's the flaw: both read the same value, so one addition is written over the other.",
      ),
    "review-record": (n) => model("", [JSON.stringify({ resolved: n % 2 === 0 })]),
    // The review that opens the next session: two questions, the first answer finding the leak
    // on the prediction, the second ending it.
    "opening-review": (n) =>
      model(
        n % 2 === 1
          ? "Before we start, your homework. You predicted the counter would reach 2000. Look at the two lines inside the loop: what can the other worker do between reading `counter` and writing it back?"
          : "And the number changing from run to run: what decides how often the two workers' moves overlap?",
      ),
    "opening-review-decision": (n) =>
      model("", [
        JSON.stringify({
          actions: [],
          resolved: n % 2 === 1 ? ["L1"] : [],
          finished: n % 2 === 0,
        }),
      ]),
    "opening-review-summary": () =>
      model(
        "The lost update held once looked at: they now see both workers reading the same value. What decides how often the moves overlap is still open: they said it's luck.",
      ),
    "track-name": () => model("", [JSON.stringify({ name: "Demo track" })]),
    "track-brief": () => model("The demo doesn't read files; this stands in for their summary."),
    "wording-review": () => model("", [JSON.stringify({ flagged: [], jargon: [] })]),
    // The first session confirms the working copy; the final's closes the fix-list item its audit
    // found no trace of, and leaves the teach-back's break as it left it.
    "term-sweep": (n) =>
      model("", [
        JSON.stringify({
          actions:
            n > 1
              ? [{ type: "close-fix-item", text: "Thinks adding one is a single step" }]
              : [
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
