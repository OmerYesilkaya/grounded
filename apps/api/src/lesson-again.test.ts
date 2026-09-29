import { asc, checkMessages, eq, sessionEvents } from "@grounded/db";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { ProviderCallError } from "./engine/model-call.js";
import { OUTLINE_FAILED } from "./engine/session-tasks.js";
import { captureLogs } from "./log.js";
import { createFlows } from "./test/flows.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";

const models = scriptedModels();
const t = createTestHarness({ models: models.access });
const { snapshot, until, planned } = createFlows(t, models);

beforeEach(() => {
  models.reset();
});

// Each step rests on the one before it, so each ends with a check.
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
    {
      heading: "Why it hides",
      establishes: "it needs bad timing",
      introduces: [],
      restsOn: ["lost update"],
    },
  ],
};
const step = (heading: string, body: string, check?: string) =>
  check ? `## ${heading}\n\n${body}\n\n:::check\n${check}\n:::` : `## ${heading}\n\n${body}`;
const S1 = step(
  "Adding one is three moves",
  "The value is copied out into a working copy, changed, and put back.",
  "What is in memory meanwhile?",
);
const S2 = step("Two workers", "Both copy 5, and one addition vanishes: a lost update.", "Why 6?");
// Without the check placed on it: it breaks a rule every time it is written.
const BROKEN_S2 = step("Two workers", "Both copy 5, and one addition vanishes: a lost update.");
const S3 = step("Why it hides", "It only happens when the timing is just wrong.", "Why hidden?");

const post = (cookie: string, sessionId: string, path: string) =>
  t.request(`/api/sessions/${sessionId}/${path}`, { method: "POST", cookie });

const eventsOf = async (sessionId: string, type: string) =>
  (
    await t.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId))
      .orderBy(asc(sessionEvents.id))
  )
    .filter((e) => e.type === type)
    .map((e) => e.data);

/** A lesson whose second step kept breaking a rule: written without it, and failed. */
async function failedMidway() {
  const session = await planned();
  models.script("lesson", {
    text: [S1, BROKEN_S2, S3].join("\n\n"),
    thenGenerate: [JSON.stringify(OUTLINE), BROKEN_S2, BROKEN_S2],
  });
  await post(session.cookie, session.sessionId, "approve-plan");
  await until(session.cookie, session.sessionId, (s) => s.state.lesson.status === "failed");
  return session;
}

describe("a lesson that failed", () => {
  it("fails when a step can't be written, keeping the steps around it", async () => {
    const { cookie, sessionId } = await failedMidway();
    const s = await snapshot(cookie, sessionId);
    expect(s.lesson?.steps.map((x) => x.id)).toEqual(["s1", "s3"]);
    expect(await eventsOf(sessionId, "lesson-step-failed")).toEqual([
      { stepId: "s2", heading: "Two workers" },
    ]);
  });

  it("writes the rest again from the first step missing, keeping the ones before it", async () => {
    const { cookie, sessionId } = await failedMidway();
    await t.db
      .insert(checkMessages)
      .values({ sessionId, stepId: "s3", role: "learner", text: "an answer read too early" });
    models.script("lesson", { text: [S2, S3].join("\n\n") });

    const again = await post(cookie, sessionId, "lesson/write-rest");
    expect(again.status).toBe(200);
    await until(cookie, sessionId, (s) => s.lesson?.steps.length === 3);
    const s = await snapshot(cookie, sessionId);
    expect(s.lesson?.steps.map((x) => x.id)).toEqual(["s1", "s2", "s3"]);
    expect(s.lesson?.totalSteps).toBe(3);
    expect(s.state).toMatchObject({ lesson: { status: "ready" }, currentStep: "s1" });
    // What the dropped steps had goes with them; the browser is told what is kept.
    expect(s.checks).toEqual([]);
    expect(await eventsOf(sessionId, "lesson-again")).toEqual([{ keep: ["s1"], totalSteps: 3 }]);
    // No new outline: the rest is written on the one it had.
    const [call] = models.used.filter((u) => u.purpose === "lesson").slice(-1);
    expect(call?.model.doGenerateCalls).toHaveLength(0);
  });

  it("starts the lesson over: a new outline, and nothing of the old one kept", async () => {
    const { cookie, sessionId } = await failedMidway();
    models.script("lesson", {
      text: [S1, S2, S3].join("\n\n"),
      thenGenerate: [JSON.stringify(OUTLINE)],
    });

    expect((await post(cookie, sessionId, "lesson/start-over")).status).toBe(200);
    await until(
      cookie,
      sessionId,
      (s) => s.state.lesson.status === "ready" && s.lesson?.steps.length === 3,
    );
    expect(await eventsOf(sessionId, "lesson-again")).toEqual([{ keep: [], totalSteps: 0 }]);
  });

  it("can be written again when it failed before its outline, from the start only", async () => {
    const session = await planned();
    const { cookie, sessionId } = session;
    const outOfCredit = new ProviderCallError("no-credit", "Your OpenAI account is out of credit.");
    models.script(
      "lesson",
      new MockLanguageModelV4({ doGenerate: () => Promise.reject(outOfCredit) }),
    );
    await post(cookie, sessionId, "approve-plan");
    await until(cookie, sessionId, (s) => s.state.lesson.status === "failed");

    const rest = await post(cookie, sessionId, "lesson/write-rest");
    expect(rest.status).toBe(409);
    expect(await rest.json()).toEqual({
      error: "The lesson has no outline yet: start it over instead.",
    });

    models.script("lesson", {
      text: [S1, S2, S3].join("\n\n"),
      thenGenerate: [JSON.stringify(OUTLINE)],
    });
    expect((await post(cookie, sessionId, "lesson/start-over")).status).toBe(200);
    await until(cookie, sessionId, (s) => s.lesson?.steps.length === 3);
  });

  it("says why when no outline fits the term list, logs what was wrong without the terms, and can start over", async () => {
    const captured = captureLogs("info");
    onTestFinished(captured.restore);
    const { cookie, sessionId } = await planned();
    // Three outlines that rest on "lost update" before any step introduces it.
    const [first] = OUTLINE.steps;
    const early = JSON.stringify({ ...OUTLINE, steps: [{ ...first, restsOn: ["lost update"] }] });
    models.script("lesson", { thenGenerate: [early, early, early] });
    await post(cookie, sessionId, "approve-plan");
    await until(cookie, sessionId, (s) => s.state.lesson.status === "failed");
    await t.waitFor(async () => (await eventsOf(sessionId, "error")).length > 0);

    expect(await eventsOf(sessionId, "error")).toEqual([{ message: OUTLINE_FAILED }]);
    const lines = captured.lines.filter((l) => String(l.message).startsWith("lesson outline"));
    expect(lines.map((l) => [l.message, l.codes, l.steps])).toEqual([
      ["lesson outline didn't fit the term list; asking again", { "outline/not-held": 1 }, [1]],
      ["lesson outline didn't fit the term list; asking again", { "outline/not-held": 1 }, [1]],
      ["lesson outline didn't fit the term list in any attempt", { "outline/not-held": 1 }, [1]],
    ]);
    expect(captured.text()).not.toContain("lost update");
    // The learner was told, so the job counts as done: nothing for the next worker to recover.
    expect(captured.lines.filter((l) => l.message === "job failed")).toMatchObject([
      { handled: true, level: "warn" },
    ]);

    models.script("lesson", {
      text: [S1, S2, S3].join("\n\n"),
      thenGenerate: [JSON.stringify(OUTLINE)],
    });
    expect((await post(cookie, sessionId, "lesson/start-over")).status).toBe(200);
    await until(cookie, sessionId, (s) => s.lesson?.steps.length === 3);
  });

  it("is the only lesson that can be written again", async () => {
    const session = await planned();
    const { cookie, sessionId } = session;
    models.script("lesson", {
      text: [S1, S2, S3].join("\n\n"),
      thenGenerate: [JSON.stringify(OUTLINE)],
    });
    await post(cookie, sessionId, "approve-plan");
    await until(cookie, sessionId, (s) => s.lesson?.steps.length === 3);

    const again = await post(cookie, sessionId, "lesson/start-over");
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: "Only a lesson that failed can be written again.",
    });
  });
});
