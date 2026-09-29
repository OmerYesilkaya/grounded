import type { SessionState } from "@grounded/core";
import { asc, eq, learningSessions, sessionEvents } from "@grounded/db";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { ProviderCallError } from "./engine/model-call.js";
import { FIRST_QUESTION, createFlows, homework, storedMessages } from "./test/flows.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";

const models = scriptedModels();
const t = createTestHarness({ models: models.access });
const { snapshot, until, learner, planned, startedSession, putOffHomework } = createFlows(
  t,
  models,
);

beforeEach(() => {
  models.reset();
});

const outOfCredit = () =>
  new ProviderCallError("no-credit", "Your OpenAI account is out of credit.");
/** A model whose every call fails, as a provider out of credit does. */
const failing = () =>
  new MockLanguageModelV4({
    doStream: () => Promise.reject(outOfCredit()),
    doGenerate: () => Promise.reject(outOfCredit()),
  });

const HOMEWORK = "Predict what a counter shows after two workers add one 1000 times each.";
const RECAP = "We built why a counter can lose an update: adding one is three moves.";

const errors = async (sessionId: string) =>
  (
    await t.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId))
      .orderBy(asc(sessionEvents.id))
  ).filter((e) => e.type === "error");

const retry = (cookie: string, sessionId: string) =>
  t.request(`/api/sessions/${sessionId}/retry`, { method: "POST", cookie });

/** A session whose lesson is done, in the phase given, as a check's last verdict leaves it. */
async function after(phase: "homework" | "close") {
  const session = await planned();
  const state: SessionState = {
    phase,
    plan: "approved",
    lesson: { status: "ready", steps: [] },
    steps: {},
    currentStep: null,
  };
  await t.db
    .update(learningSessions)
    .set({ state })
    .where(eq(learningSessions.id, session.sessionId));
  return session;
}

/** Everything the close needs after the recap: the term sweep and "where you left off". */
function scriptTheCloseAfterTheRecap() {
  models.script("term-sweep", { thenGenerate: [JSON.stringify({ actions: [] })] });
  models.script("left-off", { text: "Owed: the homework on the counter." });
}

describe("a job the learner can't set going again by writing", () => {
  it("is tried again when the homework failed, and the session goes on to its close", async () => {
    const { cookie, sessionId } = await after("homework");
    models.script("homework", failing());
    await t.queue.enqueue("homework", { sessionId });
    await t.waitFor(async () => (await errors(sessionId)).length > 0);
    await until(cookie, sessionId, (s) => s.stalled);

    models.script("homework", homework(HOMEWORK));
    models.script("close", { text: RECAP });
    scriptTheCloseAfterTheRecap();
    const retried = await retry(cookie, sessionId);
    expect(retried.status).toBe(202);
    expect(await retried.json()).toEqual({ job: "homework" });
    await putOffHomework(cookie, sessionId);
    await until(cookie, sessionId, (s) => s.state.phase === "closed");
    const s = await snapshot(cookie, sessionId);
    expect(s.messages.map((m) => m.kind).slice(-2)).toEqual(["homework", "recap"]);
    expect(s.stalled).toBe(false);

    const again = await retry(cookie, sessionId);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "There is nothing to try again." });
  });

  it("keeps a recap the learner has read when the close failed after it", async () => {
    const { cookie, sessionId } = await after("close");
    models.script("close", { text: RECAP });
    models.script("term-sweep", failing());
    await t.queue.enqueue("recap", { sessionId });
    await until(cookie, sessionId, (s) => s.stalled);
    expect((await snapshot(cookie, sessionId)).messages.at(-1)?.kind).toBe("recap");

    scriptTheCloseAfterTheRecap();
    expect((await retry(cookie, sessionId)).status).toBe(202);
    await until(cookie, sessionId, (s) => s.state.phase === "closed");
    const s = await snapshot(cookie, sessionId);
    expect(s.messages.filter((m) => m.kind === "recap")).toHaveLength(1);
    expect(models.used.filter((u) => u.purpose === "close")).toHaveLength(1);
    // The sweep hears the recap once, as the conversation's last turn.
    const sweep = models.used.findLast((u) => u.purpose === "term-sweep");
    const prompt = JSON.stringify(sweep?.model.doGenerateCalls[0]?.prompt);
    expect(prompt.split(RECAP)).toHaveLength(2);
  });

  it("is tried again when the opening question failed", async () => {
    const { cookie, trackId } = await learner();
    models.script("probe", failing());
    const started = await t.request(`/api/tracks/${trackId}/sessions`, { method: "POST", cookie });
    const { id: sessionId } = (await started.json()) as { id: string };
    await until(cookie, sessionId, (s) => s.stalled);

    models.script("probe", { text: FIRST_QUESTION });
    expect((await retry(cookie, sessionId)).status).toBe(202);
    await until(cookie, sessionId, storedMessages(1));
  });

  it("isn't stalled while it is the learner's turn", async () => {
    const { cookie, sessionId } = await startedSession();
    expect((await snapshot(cookie, sessionId)).stalled).toBe(false);
    expect((await retry(cookie, sessionId)).status).toBe(409);
  });
});
