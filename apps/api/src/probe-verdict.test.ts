import { PROBE_VERDICT_PROMPT, type ProbeVerdict } from "@grounded/core";
import { eq, fixListItems, learningSessions, lessons, sql } from "@grounded/db";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import type { VerdictState } from "./engine/probe-verdict.js";
import { ProviderCallError } from "./engine/model-call.js";
import { recoverAbandonedWork } from "./engine/recovery.js";
import {
  createFlows,
  FIRST_QUESTION,
  PLAN_TEXT,
  PROBE_SUMMARY,
  planAttempt,
  probeGoesOn,
  storedMessages,
} from "./test/flows.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";

const models = scriptedModels();
const t = createTestHarness({ models: models.access });
const { snapshot, until, startedSession, planned } = createFlows(t, models);

beforeEach(() => {
  models.reset();
});

const VERDICT: ProbeVerdict = {
  strands: [
    {
      name: "What adding one does",
      band: "working",
      text: "You know a program changes a number in memory. It got shaky where two parts of a program change it at once.",
    },
  ],
  overall: {
    band: "working",
    text: "You have something to build on: the way to a counter that never loses a count starts there.",
  },
};

const verdictOf = async (cookie: string, sessionId: string) =>
  ((await snapshot(cookie, sessionId)) as unknown as { verdict: VerdictState | null }).verdict;

const ask = (cookie: string, sessionId: string) =>
  t.request(`/api/sessions/${sessionId}/verdict`, { method: "POST", cookie });

const written = (cookie: string, sessionId: string) =>
  t.waitFor(async () => (await verdictOf(cookie, sessionId))?.status === "written");

describe("see where you stand", () => {
  it("is offered once the track's first probe is over, and written when the learner asks", async () => {
    const { cookie, sessionId } = await planned();
    expect(await verdictOf(cookie, sessionId)).toEqual({
      status: "offered",
      verdict: null,
      failure: null,
    });

    models.script("probe-verdict", { text: JSON.stringify(VERDICT) });
    const asked = await ask(cookie, sessionId);
    expect(asked.status).toBe(202);
    expect(((await asked.json()) as VerdictState).status).toBe("writing");
    await written(cookie, sessionId);
    expect(await verdictOf(cookie, sessionId)).toEqual({
      status: "written",
      verdict: VERDICT,
      failure: null,
    });

    // From the probe's records: its conversation and what it found, not the plan after it.
    const call = models.used.find((u) => u.purpose === "probe-verdict")?.model.doGenerateCalls[0];
    const prompt = JSON.stringify(call?.prompt);
    expect(prompt).toContain("it just adds one");
    expect(prompt).toContain(PROBE_SUMMARY);
    // The misconception the probe noted (the flow's decision adds it).
    expect(prompt).toContain("Thinks adding one is a single step");
    expect(prompt).toContain(JSON.stringify(PROBE_VERDICT_PROMPT).slice(1, 60));
    expect(prompt).not.toContain(PLAN_TEXT);
    // The plan's summary stays the tutor's.
    const [row] = await t.db
      .select()
      .from(learningSessions)
      .where(eq(learningSessions.id, sessionId));
    expect(row?.probeSummary).toBe(PROBE_SUMMARY);

    // Written once: asking again shows it, with no second call.
    const again = await ask(cookie, sessionId);
    expect(again.status).toBe(200);
    expect(models.used.filter((u) => u.purpose === "probe-verdict")).toHaveLength(1);
  });

  it("reads the probe's records only, not what the lesson recorded after it", async () => {
    const { cookie, sessionId, trackId } = await planned();
    await t.db.insert(lessons).values({ sessionId });
    await t.db.insert(fixListItems).values({ trackId, text: "Mixes up the two copies" });
    models.script("probe-verdict", { text: JSON.stringify(VERDICT) });
    await ask(cookie, sessionId);
    await written(cookie, sessionId);
    const call = models.used.find((u) => u.purpose === "probe-verdict")?.model.doGenerateCalls[0];
    const prompt = JSON.stringify(call?.prompt);
    expect(prompt).toContain("Thinks adding one is a single step");
    expect(prompt).not.toContain("Mixes up the two copies");
  });

  it("is sent as an event, so an open chat shows it as it lands", async () => {
    const { cookie, sessionId } = await planned();
    models.script("probe-verdict", { text: JSON.stringify(VERDICT) });
    await ask(cookie, sessionId);
    await written(cookie, sessionId);
    const events = await t.db.execute<{ data: VerdictState }>(
      sql`select data from session_events where session_id = ${sessionId} and type = 'probe-verdict' order by id`,
    );
    expect(events.map((e) => e.data.status)).toEqual(["writing", "written"]);
  });

  it("isn't offered while the probe goes on", async () => {
    const { cookie, sessionId } = await startedSession();
    expect(await verdictOf(cookie, sessionId)).toBeNull();
    models.script("probe-decision", probeGoesOn());
    models.script("probe", { text: "Next one: where is the number while it changes?" });
    await t.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ text: "it adds one" }),
    });
    await until(cookie, sessionId, storedMessages(3));
    expect(await verdictOf(cookie, sessionId)).toBeNull();
    expect((await ask(cookie, sessionId)).status).toBe(409);
  });

  it("isn't offered when the learner skipped to the plan before any answer", async () => {
    const { cookie, sessionId } = await startedSession();
    models.script("plan", planAttempt(PLAN_TEXT));
    await t.request(`/api/sessions/${sessionId}/skip-to-plan`, { method: "POST", cookie });
    await until(cookie, sessionId, (s) => s.state.plan === "proposed");
    expect(await verdictOf(cookie, sessionId)).toBeNull();
  });

  it("is offered when the learner skipped ahead after an answer, with no summary for the plan", async () => {
    const { cookie, sessionId } = await startedSession();
    models.script("probe-decision", probeGoesOn());
    models.script("probe", { text: "Next one: where is the number while it changes?" });
    await t.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ text: "no idea, honestly" }),
    });
    await until(cookie, sessionId, storedMessages(3));
    models.script("plan", planAttempt(PLAN_TEXT));
    await t.request(`/api/sessions/${sessionId}/skip-to-plan`, { method: "POST", cookie });
    await until(cookie, sessionId, (s) => s.state.plan === "proposed");
    expect((await verdictOf(cookie, sessionId))?.status).toBe("offered");

    models.script("probe-verdict", { text: JSON.stringify(VERDICT) });
    await ask(cookie, sessionId);
    await written(cookie, sessionId);
    const call = models.used.find((u) => u.purpose === "probe-verdict")?.model.doGenerateCalls[0];
    expect(JSON.stringify(call?.prompt)).toContain("no idea, honestly");
  });

  it("isn't offered after a later session's probe", async () => {
    const { cookie, trackId, sessionId } = await planned();
    await t.db
      .update(learningSessions)
      .set({ closedAt: new Date() })
      .where(eq(learningSessions.id, sessionId));
    models.script("probe", { text: FIRST_QUESTION });
    const started = await t.request(`/api/tracks/${trackId}/sessions`, { method: "POST", cookie });
    const { id } = (await started.json()) as { id: string };
    await until(cookie, id, storedMessages(1));
    models.script("probe-decision", {
      thenGenerate: [JSON.stringify({ actions: [], finished: true })],
    });
    models.script("probe-summary", { text: PROBE_SUMMARY });
    models.script("plan", planAttempt(PLAN_TEXT));
    await t.request(`/api/sessions/${id}/messages`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ text: "it adds one" }),
    });
    await until(cookie, id, (s) => s.state.plan === "proposed");
    expect(await verdictOf(cookie, id)).toBeNull();
    // The first session's stays offered, at its seam.
    expect((await verdictOf(cookie, sessionId))?.status).toBe("offered");
  });

  it("is rewritten once when it breaks the chat's rules", async () => {
    const { cookie, sessionId } = await planned();
    const machinery = {
      ...VERDICT,
      overall: { band: "working", text: "Your ledger shows a start: we build from there." },
    };
    models.script("probe-verdict", {
      thenGenerate: [JSON.stringify(machinery), JSON.stringify(VERDICT)],
    });
    await ask(cookie, sessionId);
    await written(cookie, sessionId);
    expect((await verdictOf(cookie, sessionId))?.verdict).toEqual(VERDICT);
    const calls = models.used.find((u) => u.purpose === "probe-verdict")?.model.doGenerateCalls;
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls?.[1]?.prompt)).toContain("ledger");
  });

  it("says why when it can't be written, and the learner can ask again", async () => {
    const { cookie, sessionId } = await planned();
    const outOfCredit = new ProviderCallError("no-credit", {
      code: "provider-failed",
      kind: "no-credit",
      provider: "OpenAI",
    });
    models.script(
      "probe-verdict",
      new MockLanguageModelV4({ doGenerate: () => Promise.reject(outOfCredit) }),
    );
    await ask(cookie, sessionId);
    await t.waitFor(async () => (await verdictOf(cookie, sessionId))?.status === "failed");
    expect((await verdictOf(cookie, sessionId))?.failure).toEqual(outOfCredit.notice);

    models.script("probe-verdict", { text: JSON.stringify(VERDICT) });
    expect((await ask(cookie, sessionId)).status).toBe(202);
    await written(cookie, sessionId);
    // The session goes on regardless: it waits on nothing.
    expect((await snapshot(cookie, sessionId)).stalled).toBe(false);
  });

  it("is marked failed by recovery when the job writing it died, in a closed session too", async () => {
    const { cookie, sessionId } = await planned();
    await t.db
      .update(learningSessions)
      .set({
        closedAt: new Date(),
        probeVerdictStatus: "writing",
        probeVerdictAt: new Date(Date.now() - 60_000),
      })
      .where(eq(learningSessions.id, sessionId));
    await recoverAbandonedWork(t.db, { quietForMs: 30_000 });
    expect(await verdictOf(cookie, sessionId)).toMatchObject({
      status: "failed",
      failure: { code: "interrupted" },
    });
  });

  it("leaves a verdict just asked for to its job", async () => {
    const { cookie, sessionId } = await planned();
    await t.db
      .update(learningSessions)
      .set({ probeVerdictStatus: "writing", probeVerdictAt: new Date() })
      .where(eq(learningSessions.id, sessionId));
    await recoverAbandonedWork(t.db, { quietForMs: 30_000 });
    expect((await verdictOf(cookie, sessionId))?.status).toBe("writing");
  });

  it("is on the track page as where the learner started, once written", async () => {
    const { cookie, sessionId, trackId } = await planned();
    const progress = async () =>
      (
        (await (await t.request(`/api/tracks/${trackId}/progress`, { cookie })).json()) as {
          started: unknown;
        }
      ).started;
    expect(await progress()).toBeNull();
    models.script("probe-verdict", { text: JSON.stringify(VERDICT) });
    await ask(cookie, sessionId);
    await written(cookie, sessionId);
    expect(await progress()).toEqual({ sessionId, verdict: VERDICT });
  });
});
