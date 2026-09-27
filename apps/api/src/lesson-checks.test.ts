import { beforeEach, describe, expect, it } from "vitest";
import { createFlows } from "./test/flows.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";

const models = scriptedModels();
const t = createTestHarness({ models: models.access });
const { snapshot, until, planned } = createFlows(t, models);

beforeEach(() => {
  models.reset();
});

// s2 builds on what s1 introduces; s3 doesn't build on s2.
const OUTLINE = {
  steps: [
    {
      heading: "Adding one is three moves",
      establishes: "copy, change, put back",
      introduces: ["working copy"],
      restsOn: [],
      check: "What is in memory meanwhile?",
    },
    {
      heading: "Two workers",
      establishes: "interleaving loses an update",
      introduces: ["lost update"],
      restsOn: ["working copy"],
      check: "Why 6 and not 7?",
    },
    {
      heading: "Why it hides",
      establishes: "it needs bad timing",
      introduces: [],
      restsOn: [],
      check: "Why can it hide for months?",
    },
  ],
};
const step = (heading: string, body: string, check: string) =>
  `## ${heading}\n\n${body}\n\n:::check\n${check}\n:::`;
const LESSON = [
  step(
    "Adding one is three moves",
    "The value is copied out into a working copy, changed, and put back.",
    "What is in memory meanwhile?",
  ),
  step("Two workers", "Both copy 5, and one addition vanishes: a lost update.", "Why 6 and not 7?"),
  step(
    "Why it hides",
    "It only happens when the timing is just wrong.",
    "Why can it hide for months?",
  ),
].join("\n\n");

const verdict = (v: {
  verdict: "landed" | "missed";
  reply: string;
  freshQuestion?: string;
  note?: string;
}) => ({
  thenGenerate: [JSON.stringify({ actions: [], ...v })],
});

async function inLesson() {
  const session = await planned();
  models.script("lesson", { text: LESSON, thenGenerate: [JSON.stringify(OUTLINE)] });
  const approved = await t.request(`/api/sessions/${session.sessionId}/approve-plan`, {
    method: "POST",
    cookie: session.cookie,
  });
  expect(approved.status).toBe(200);
  await until(session.cookie, session.sessionId, (s) => s.lesson?.steps.length === 3);
  return session;
}

const answer = (cookie: string, sessionId: string, stepId: string, body: object) =>
  t.request(`/api/sessions/${sessionId}/steps/${stepId}/answer`, {
    method: "POST",
    cookie,
    body: JSON.stringify(body),
  });

const tutorReplies = (s: Awaited<ReturnType<typeof snapshot>>, stepId: string) =>
  s.checks.filter((m) => m.stepId === stepId && m.role === "tutor");

describe("the lesson", () => {
  it("is written step by step and opens at the first check", async () => {
    const { cookie, sessionId } = await inLesson();
    const s = await snapshot(cookie, sessionId);
    expect(s.lesson?.steps.map((x) => x.id)).toEqual(["s1", "s2", "s3"]);
    expect(s.lesson?.totalSteps).toBe(3);
    expect(s.state).toMatchObject({
      phase: "lesson",
      currentStep: "s1",
      lesson: { status: "ready" },
    });
  });
});

describe("checks", () => {
  it("opens the next step when the check lands", async () => {
    const { cookie, sessionId } = await inLesson();
    models.script("check", verdict({ verdict: "landed", reply: "That's it." }));
    expect((await answer(cookie, sessionId, "s1", { text: "memory still holds 5" })).status).toBe(
      202,
    );
    await until(cookie, sessionId, (s) => s.state.currentStep === "s2");

    const s = await snapshot(cookie, sessionId);
    expect(s.checks.map((m) => [m.stepId, m.role, m.verdict])).toEqual([
      ["s1", "learner", null],
      ["s1", "tutor", "landed"],
    ]);
  });

  it("repairs a miss with a fresh question, and notes where the step leaked", async () => {
    const { cookie, sessionId } = await inLesson();
    models.script(
      "check",
      verdict({
        verdict: "missed",
        reply: "Close. Memory keeps the **old** value until the copy is put back.",
        freshQuestion: "Two workers each copy 10. What does memory hold while they work?",
        note: "The value in memory doesn't change until the copy is put back.",
      }),
    );
    await answer(cookie, sessionId, "s1", { text: "the new value" });
    await until(cookie, sessionId, (s) => tutorReplies(s, "s1").length === 2);

    const s = await snapshot(cookie, sessionId);
    expect(tutorReplies(s, "s1").map((m) => m.verdict)).toEqual(["missed", null]);
    expect(s.state.steps.s1).toEqual({ status: "open", misses: 1, offerGate: false });
    expect(s.lesson?.notes.s1).toBe(
      "The value in memory doesn't change until the copy is put back.",
    );
  });

  it("offers pause or continue after a second miss when the next step rests on this one", async () => {
    const { cookie, sessionId } = await inLesson();
    models.script(
      "check",
      verdict({ verdict: "missed", reply: "Not yet.", freshQuestion: "Try this one?" }),
      verdict({ verdict: "missed", reply: "This idea is still settling; that's fine." }),
    );
    await answer(cookie, sessionId, "s1", { dontKnow: true });
    await until(cookie, sessionId, (s) => tutorReplies(s, "s1").length === 2);
    await answer(cookie, sessionId, "s1", { text: "still not sure" });
    await until(cookie, sessionId, (s) => s.state.steps.s1?.offerGate === true);

    const blocked = await answer(cookie, sessionId, "s1", { text: "one more try" });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: "Choose to pause or continue first." });

    expect(
      (await t.request(`/api/sessions/${sessionId}/steps/s1/pause`, { method: "POST", cookie }))
        .status,
    ).toBe(200);
    expect((await snapshot(cookie, sessionId)).state.steps.s1?.status).toBe("paused");

    models.script("check", {
      thenGenerate: ["Fresh angle: what is in memory while a copy is being changed?"],
    });
    expect(
      (await t.request(`/api/sessions/${sessionId}/resume`, { method: "POST", cookie })).status,
    ).toBe(200);
    await until(cookie, sessionId, (s) => tutorReplies(s, "s1").length === 3);
    expect((await snapshot(cookie, sessionId)).state.steps.s1).toEqual({
      status: "open",
      misses: 0,
      offerGate: false,
    });
  });

  it("continue anyway leaves the step settling and moves on", async () => {
    const { cookie, sessionId } = await inLesson();
    models.script(
      "check",
      verdict({ verdict: "missed", reply: "Not yet.", freshQuestion: "Try this?" }),
      verdict({ verdict: "missed", reply: "Still settling." }),
    );
    await answer(cookie, sessionId, "s1", { dontKnow: true });
    await until(cookie, sessionId, (s) => tutorReplies(s, "s1").length === 2);
    await answer(cookie, sessionId, "s1", { dontKnow: true });
    await until(cookie, sessionId, (s) => s.state.steps.s1?.offerGate === true);

    await t.request(`/api/sessions/${sessionId}/steps/s1/continue`, { method: "POST", cookie });
    const s = await snapshot(cookie, sessionId);
    expect(s.state.steps.s1?.status).toBe("settling");
    expect(s.state.currentStep).toBe("s2");
  });

  it("moves to homework once every check is resolved", async () => {
    const { cookie, sessionId } = await inLesson();
    models.script(
      "check",
      verdict({ verdict: "landed", reply: "Yes." }),
      verdict({ verdict: "landed", reply: "Yes." }),
      verdict({ verdict: "landed", reply: "Yes." }),
    );
    for (const id of ["s1", "s2", "s3"]) {
      await answer(cookie, sessionId, id, { text: "an answer" });
      await until(cookie, sessionId, (s) => s.state.steps[id]?.status === "passed");
    }
    await until(cookie, sessionId, (s) => s.state.phase === "homework");
  });

  it("only takes an answer for the step being checked", async () => {
    const { cookie, sessionId } = await inLesson();
    const early = await answer(cookie, sessionId, "s2", { text: "jumping ahead" });
    expect(early.status).toBe(409);
    expect(await early.json()).toEqual({ error: "That step isn't the one being checked." });
  });
});
