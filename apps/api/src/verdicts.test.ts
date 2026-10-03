import { loadMethod } from "@grounded/core";
import { asc, eq, modelCalls, usageEvents } from "@grounded/db";
import { beforeEach, describe, expect, it } from "vitest";
import { createFlows, homework } from "./test/flows.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";
import { throughTheCaller } from "./test/stored-models.js";

// The validators' verdicts, as stored on the calls they judged (design §4.4): the scripted models
// are called through the real model caller, which stores every call.
const models = scriptedModels();
const t = createTestHarness({ models: throughTheCaller(models.access, () => t) });
const { until, planned, startedSession, putOffHomework } = createFlows(t, models);

beforeEach(() => {
  models.reset();
});

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
      heading: "Two workers",
      establishes: "interleaving loses an update",
      introduces: ["lost update"],
      restsOn: ["working copy"],
    },
  ],
};
const LESSON = [
  '## Adding one is three moves\n\nThe value is copied out, changed, and put back.\n\n:::word{term="working copy"}\nThe copy of a value that is changed before it is put back.\n:::\n\n:::check\nWhat is in memory meanwhile?\n:::',
  '## Two workers\n\nBoth copy 5, and one addition vanishes.\n\n:::word{term="lost update"}\nAn addition that vanishes because another copy was put back over it.\n:::\n\n:::check\nWhy 6 and not 7?\n:::',
].join("\n\n");

async function inLesson() {
  const session = await planned();
  models.script("lesson", { text: LESSON, thenGenerate: [JSON.stringify(OUTLINE)] });
  await t.request(`/api/sessions/${session.sessionId}/approve-plan`, {
    method: "POST",
    cookie: session.cookie,
  });
  await until(session.cookie, session.sessionId, (s) => s.lesson?.steps.length === 2);
  return session;
}

const answer = (cookie: string, sessionId: string, text: string, stepId = "s1") =>
  t.request(`/api/sessions/${sessionId}/steps/${stepId}/answer`, {
    method: "POST",
    cookie,
    body: JSON.stringify({ text }),
  });

const graded = (fields: object) =>
  JSON.stringify({
    verdict: "landed",
    reply: "Right.",
    freshQuestion: null,
    note: null,
    alreadyHeld: null,
    actions: [],
    ...fields,
  });

/** The stored calls for a purpose, in the order they were made, with their verdicts. */
async function verdictsOf(purpose: string) {
  const rows = await t.db
    .select({ verdict: modelCalls.verdict })
    .from(modelCalls)
    .innerJoin(usageEvents, eq(usageEvents.id, modelCalls.usageEventId))
    .where(eq(usageEvents.purpose, purpose))
    .orderBy(asc(usageEvents.createdAt), asc(usageEvents.id));
  return rows.map((row) => row.verdict);
}

describe("check replies", () => {
  it("keep the verdict on each grading: the broken rule on the first, none on the one after", async () => {
    const { cookie, sessionId } = await inLesson();
    models.script("check", {
      thenGenerate: [
        graded({
          verdict: "missed",
          reply: "Close. So what does it hold meanwhile?",
          freshQuestion: "Two workers each copy 10. What does memory hold?",
        }),
        graded({
          verdict: "missed",
          reply: "Close. Memory keeps the old value.",
          freshQuestion: "Two workers each copy 10. What does memory hold?",
        }),
      ],
    });
    await answer(cookie, sessionId, "the new value");
    await until(cookie, sessionId, (s) => s.checks.some((m) => m.role === "tutor"));
    await t.waitFor(async () => (await verdictsOf("check")).at(-1) !== null);

    expect(await verdictsOf("check")).toEqual([
      {
        rewrite: 0,
        issues: [{ code: "check/repair-asks", message: expect.any(String) as string }],
      },
      { rewrite: 1, issues: [] },
    ]);
  });
});

/** An edit the track can't take: the term isn't in it. */
const UNKNOWN = { type: "set-term-status", term: "nonsense", status: "confirmed", evidence: "x" };
const unknownTerm = {
  code: "unknown-term",
  message: expect.stringContaining("nonsense") as string,
};

describe("track edits", () => {
  it("keep their rejections on the call that made them, and on the one that sent them again", async () => {
    const { cookie, sessionId } = await startedSession();
    models.script("probe-decision", {
      thenGenerate: [
        JSON.stringify({ actions: [UNKNOWN], finished: false }),
        JSON.stringify({ actions: [] }),
      ],
    });
    models.script("probe", { text: "And what happens when two workers do it at once?" });
    await t.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ text: "it just adds one" }),
    });
    await until(cookie, sessionId, (s) => s.messages.length === 3 && !s.messages[2]?.streaming);

    expect(await verdictsOf("probe-decision")).toEqual([
      { rewrite: 0, issues: [unknownTerm] },
      { rewrite: 1, issues: [] },
    ]);
  });

  it("add to a check grading's own verdict", async () => {
    const { cookie, sessionId } = await inLesson();
    models.script("check", {
      thenGenerate: [graded({ actions: [UNKNOWN] }), JSON.stringify({ actions: [] })],
    });
    await answer(cookie, sessionId, "an answer");
    await until(cookie, sessionId, (s) => s.state.steps.s1?.status === "passed");

    expect(await verdictsOf("check")).toEqual([
      { rewrite: 0, issues: [unknownTerm] },
      { rewrite: 1, issues: [] },
    ]);
  });

  it("keep the plan's record and the term sweep's verdict on each attempt", async () => {
    const { cookie, sessionId } = await inLesson();
    models.script("check", { thenGenerate: [graded({})] }, { thenGenerate: [graded({})] });
    models.script("homework", homework("Explain it to a friend."));
    models.script("close", { text: "We built it." });
    const confirm = {
      type: "set-term-status",
      term: "lost update",
      status: "confirmed",
      evidence: "vanishes",
    };
    models.script(
      "term-sweep",
      { thenGenerate: [JSON.stringify({ actions: [confirm, UNKNOWN] })] },
      { thenGenerate: [JSON.stringify({ actions: [confirm] })] },
    );
    models.script("left-off", { text: "Owed: the homework." });
    for (const stepId of ["s1", "s2"]) {
      await answer(cookie, sessionId, "an answer", stepId);
      await until(cookie, sessionId, (s) => s.state.steps[stepId]?.status === "passed");
    }
    await putOffHomework(cookie, sessionId);
    await until(cookie, sessionId, (s) => s.state.phase === "closed");

    expect(await verdictsOf("term-sweep")).toEqual([
      { rewrite: 0, issues: [unknownTerm] },
      { rewrite: 1, issues: [] },
    ]);
    // The plan's message, then its record.
    expect(await verdictsOf("plan")).toEqual([
      { rewrite: 0, issues: [] },
      { rewrite: 0, issues: [] },
    ]);
  });
});

describe("lessons", () => {
  it("keep each outline's verdict, the stream's by step, and each rewrite's", async () => {
    const session = await planned();
    const [first, second] = OUTLINE.steps;
    if (!first || !second) throw new Error("fixture outline is short");
    const unplanned = { ...OUTLINE, steps: [{ ...first, introduces: ["mutex"] }, second] };
    // The first step comes without its check: it is rewritten, with the check.
    const [s1 = "", s2 = ""] = LESSON.split("\n\n## ");
    const unchecked = s1.replace(/\n\n:::check[\s\S]*$/, "");
    models.script("lesson", {
      text: `${unchecked}\n\n## ${s2}`,
      thenGenerate: [JSON.stringify(unplanned), JSON.stringify(OUTLINE), s1],
    });
    await t.request(`/api/sessions/${session.sessionId}/approve-plan`, {
      method: "POST",
      cookie: session.cookie,
    });
    await until(session.cookie, session.sessionId, (s) => s.lesson?.steps.length === 2);

    const brief = (await verdictsOf("lesson")).map((v) => [
      v?.rewrite,
      v?.issues.map((i) => `${i.stepId ?? ""} ${i.code ?? ""}`),
    ]);
    expect(brief).toEqual([
      // Step 1 teaches no planned term, so step 2 rests on one nothing introduced.
      [0, ["s1 outline/not-planned", "s2 outline/not-held"]],
      [1, []],
      [0, ["s1 lesson/missing-check"]],
      [1, []],
    ]);
  });
});

describe("every call", () => {
  it("records the version of the method it was made under", async () => {
    await inLesson();
    const rows = await t.db.select({ methodVersion: usageEvents.methodVersion }).from(usageEvents);
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row.methodVersion))).toEqual(new Set([loadMethod().version]));
  });
});
