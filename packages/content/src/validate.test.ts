import { describe, expect, it } from "vitest";
import { parseBlocks, parseLesson, validate, validateStep, type TrackTerm } from "./index.js";

const blocks = (markdown: string) => {
  const result = parseBlocks(markdown);
  expect(result.issues).toEqual([]);
  return result.blocks;
};

describe("validate: blocks allowed per surface", () => {
  it("keeps the probe and plan chat to text", () => {
    const content = blocks(
      "What does this print?\n\n```js\nconsole.log(1)\n```\n\n```diagram\ncaption: c\n---\nflowchart TB\n  A\n```\n\n> :::check\n> Why?\n> :::",
    );
    expect(validate(content, { surface: "chat" })).toEqual([
      {
        code: "surface/not-allowed",
        message:
          "A diagram block can't be used in the chat. Allowed there: paragraph, list, quote, code, math, table.",
        blockId: "b3",
      },
      {
        code: "surface/not-allowed",
        message:
          "A check block can't be used in the chat. Allowed there: paragraph, list, quote, code, math, table.",
        blockId: "b4.1",
      },
    ]);
  });

  it("allows drawings in a lesson, an aside and a repair, but checks only in a lesson", () => {
    const drawing = blocks("```diagram\ncaption: c\n---\nflowchart TB\n  A\n```");
    const check = blocks(":::check\nWhy?\n:::");
    expect(validate(drawing, { surface: "lesson" })).toEqual([]);
    expect(validate(drawing, { surface: "aside" })).toEqual([]);
    expect(validate(drawing, { surface: "repair" })).toEqual([]);
    expect(validate(check, { surface: "lesson" })).toEqual([]);
    expect(validate(check, { surface: "aside" }).map((i) => i.code)).toEqual([
      "surface/not-allowed",
    ]);
  });
});

describe("validate: the scaffolding stays out of sight", () => {
  it("rejects unambiguous machinery words", () => {
    const issues = validate(blocks("This hangs off the ledger we built in Phase 2."), {
      surface: "lesson",
    });
    expect(issues.map((i) => [i.code, i.severity, i.message])).toEqual([
      [
        "scaffolding/word",
        undefined,
        'Learners never see the method\'s machinery: "hangs off". Say what a tutor would say instead.',
      ],
      [
        "scaffolding/word",
        undefined,
        'Learners never see the method\'s machinery: "ledger". Say what a tutor would say instead.',
      ],
      [
        "scaffolding/word",
        undefined,
        'Learners never see the method\'s machinery: "Phase 2". Say what a tutor would say instead.',
      ],
    ]);
  });

  it("sends everyday words that may mean machinery to review", () => {
    const issues = validate(blocks("I assumed the root of the map was confirmed."), {
      surface: "lesson",
    });
    expect(issues.map((i) => [i.code, i.severity])).toEqual([
      ["scaffolding/maybe", "review"],
      ["scaffolding/maybe", "review"],
      ["scaffolding/maybe", "review"],
      ["scaffolding/maybe", "review"],
    ]);
    expect(issues[0]?.message).toBe(
      '"assumed" may refer to the method\'s machinery; check it is meant in its everyday or domain sense.',
    );
  });

  it("ignores code, maths, and words that are real domain terms of the track", () => {
    const terms: TrackTerm[] = [{ term: "graph", status: "confirmed" }];
    const content = blocks("A `node` in a graph, and $root$ in maths.");
    expect(validate(content, { surface: "lesson", terms })).toEqual([]);
  });

  it("checks captions and diagram labels too", () => {
    const content = blocks(
      '```diagram\ncaption: What hangs off what\n---\nflowchart TB\n  A["the ledger"] -->|forced by| B\n```',
    );
    expect(validate(content, { surface: "lesson" }).map((i) => i.message)).toEqual([
      expect.stringContaining('"hangs off"'),
      expect.stringContaining('"ledger"'),
      expect.stringContaining('"forced by"'),
    ]);
  });
});

describe("validate: no untaught terms", () => {
  const terms: TrackTerm[] = [
    { term: "race condition", status: "planned" },
    { term: "lock", status: "taught" },
    { term: "memory", status: "confirmed" },
    { term: "thread", status: "borrowed" },
  ];

  it("rejects planned and taught terms, in any case and plural", () => {
    const issues = validate(
      blocks("Race conditions happen without Locks, in memory, on a thread."),
      {
        surface: "lesson",
        terms,
      },
    );
    expect(issues.map((i) => [i.code, i.message])).toEqual([
      [
        "term/untaught",
        '"race condition" hasn\'t been taught yet; describe it in plain words, or introduce it where it earns its name.',
      ],
      [
        "term/untaught",
        '"lock" hasn\'t been taught yet; describe it in plain words, or introduce it where it earns its name.',
      ],
    ]);
  });

  it("allows the terms a lesson step introduces", () => {
    const content = blocks("This pattern has a name: it's called a race condition.");
    expect(validate(content, { surface: "lesson", terms, introduced: ["race condition"] })).toEqual(
      [],
    );
  });

  it("rejects jargon from the track's glossary that isn't in the plan yet", () => {
    const issues = validate(blocks("Use a mutex."), {
      surface: "aside",
      terms,
      glossary: ["mutex"],
    });
    expect(issues.map((i) => i.code)).toEqual(["term/untaught"]);
  });

  it("ignores code but checks diagram labels", () => {
    const content = blocks(
      'Run `lock()` now.\n\n```diagram\ncaption: c\n---\nflowchart TB\n  A["takes the lock"]\n```',
    );
    expect(validate(content, { surface: "lesson", terms }).map((i) => i.blockId)).toEqual(["b2"]);
  });
});

describe("validateStep", () => {
  it("validates a lesson step including its heading", () => {
    const { steps } = parseLesson("## Why a lock helps\n\nText.\n\n:::check\nWhy?\n:::");
    const [step] = steps;
    if (!step) throw new Error("expected a step");
    const issues = validateStep(step, { terms: [{ term: "lock", status: "planned" }] });
    expect(issues).toMatchObject([{ code: "term/untaught", blockId: "s1.b1" }]);
  });
});

describe("validate: word cards", () => {
  const terms: TrackTerm[] = [
    { term: "memory", status: "confirmed" },
    { term: "ontology", status: "planned" },
    { term: "epistemology", status: "planned" },
  ];
  const lesson = (markdown: string) =>
    validate(blocks(markdown), { surface: "lesson", terms, taughtHere: ["ontology"] }).map(
      (i) => i.code,
    );
  const CARD = ':::word{term="ontology"}\nThe study of what there is.\n:::';

  it("lets a word the content teaches be used from its card on, its definition included", () => {
    expect(lesson(`What is there at all?\n\n${CARD}\n\nOntology asks it first.`)).toEqual([]);
    expect(lesson(':::word{term="ontology"}\nOntology: the study of what there is.\n:::')).toEqual(
      [],
    );
  });

  it("rejects the word before its card, and a word taught here without one", () => {
    expect(lesson(`Ontology comes first.\n\n${CARD}`)).toEqual(["word/before-card"]);
    expect(lesson("What is there at all? Ontology asks.")).toEqual([
      "word/before-card",
      "word/missing-card",
    ]);
  });

  it("keeps a card's definition to words the learner holds", () => {
    expect(
      lesson(':::word{term="ontology"}\nThe part of epistemology about what there is.\n:::'),
    ).toEqual(["term/untaught"]);
  });

  it("gives no card to a word already held, or to a term taught elsewhere", () => {
    expect(lesson(`${CARD}\n\n:::word{term="memory"}\nWhere values live.\n:::`)).toEqual([
      "word/held",
    ]);
    expect(lesson(`${CARD}\n\n:::word{term="epistemology"}\nHow we know.\n:::`)).toEqual([
      "word/not-here",
    ]);
    // A label the lesson coins isn't on the list, and may have one.
    expect(lesson(`${CARD}\n\n:::word{term="the box"}\nThe memory cell we watch.\n:::`)).toEqual(
      [],
    );
  });

  it("finds a long term by the name before its colon", () => {
    const long: TrackTerm[] = [{ term: "requests table row: one API request", status: "planned" }];
    const card = ':::word{term="requests table row"}\nOne line per request.\n:::';
    expect(
      validate(blocks(card), {
        surface: "lesson",
        terms: long,
        taughtHere: ["requests table row: one API request"],
      }),
    ).toEqual([]);
  });

  it("allows a word card only in a lesson, and a preview card in a lesson or an aside", () => {
    const about = blocks(':::about{name="Immanuel Kant"}\nA German philosopher (1724–1804).\n:::');
    expect(validate(blocks(CARD), { surface: "aside" }).map((i) => i.code)).toEqual([
      "surface/not-allowed",
    ]);
    expect(validate(about, { surface: "lesson" })).toEqual([]);
    expect(validate(about, { surface: "aside" })).toEqual([]);
    expect(validate(about, { surface: "chat" }).map((i) => i.code)).toEqual([
      "surface/not-allowed",
    ]);
  });
});
