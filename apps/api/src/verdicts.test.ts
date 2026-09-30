import { asc, eq, modelCalls, usageEvents } from "@grounded/db";
import { beforeEach, describe, expect, it } from "vitest";
import { createFlows } from "./test/flows.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";
import { throughTheCaller } from "./test/stored-models.js";

// The validators' verdicts, as stored on the calls they judged (design §4.4): the scripted models
// are called through the real model caller, which stores every call.
const models = scriptedModels();
const t = createTestHarness({ models: throughTheCaller(models.access, () => t) });
const { until, planned } = createFlows(t, models);

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

const answer = (cookie: string, sessionId: string, text: string) =>
  t.request(`/api/sessions/${sessionId}/steps/s1/answer`, {
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
