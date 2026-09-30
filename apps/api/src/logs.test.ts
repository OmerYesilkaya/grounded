import { APICallError } from "@ai-sdk/provider";
import { credentials, eq, modelCalls, usageEvents, users } from "@grounded/db";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { invite } from "./allowlist.js";
import { createModelCaller, type ModelAccess } from "./engine/model-call.js";
import { captureLogs, type LogFields } from "./log.js";
import {
  FIRST_QUESTION,
  PLAN_ACTIONS,
  PLAN_TEXT,
  planAttempt,
  finishProbe,
  createFlows,
  type Snapshot,
} from "./test/flows.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";

// The scripted models, called through the real model caller: with the learner's key, decrypted.
const models = scriptedModels();
const keyed: ModelAccess = {
  async model(request) {
    const scripted = await models.access.model(request);
    return createModelCaller({
      db: t.db,
      vault: t.vault,
      createLanguageModel: () => scripted,
    }).model(request);
  },
  searchTool: (userId) => models.access.searchTool(userId),
};
const t = createTestHarness({ models: keyed });
const { until } = createFlows(t, models);

beforeEach(() => {
  models.reset();
});

/** Everything logged from here to the end of the test, at every level. */
function logs() {
  const captured = captureLogs("trace");
  onTestFinished(captured.restore);
  return captured;
}

const withMsg = (lines: LogFields[], message: string) => lines.filter((l) => l.message === message);

const KEY = "sk-proj-LOGTEST-key-9f8e7d6c5b4a";
const TITLE = "Quokka arithmetic";
// Distinctive words, so that even a piece of an answer quoted in an error shows.
const PROBE_ANSWER = "I reckon the quokka adds one in a single hop";
const CHECK_ANSWER = "the wombat still holds five in memory";
const WORDS = /quokka|wombat/i;

const OUTLINE = {
  title: "Why two writers lose an update",
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
  ],
};
const LESSON = [
  '## Adding one is three moves\n\nThe value is copied out, changed, and put back.\n\n:::word{term="working copy"}\nThe copy of a value that is changed before it is put back.\n:::\n\n:::check\nWhat is in memory meanwhile?\n:::',
  '## Two workers\n\nBoth copy 5, and one addition vanishes.\n\n:::word{term="lost update"}\nAn addition that vanishes because another copy was put back over it.\n:::\n\n:::check\nWhy 6 and not 7?\n:::',
].join("\n\n");

/** A signed-in learner with a key and a track; returns what the log must never show. */
async function keyedLearner() {
  await invite(t.db, "ada@example.com");
  const cookie = await t.signIn("ada@example.com");
  const saved = await t.request("/api/credentials", {
    method: "PUT",
    cookie,
    body: JSON.stringify({ provider: "openai", model: "gpt-6-luna", apiKey: KEY }),
  });
  expect(saved.status).toBe(200);
  const [user] = await t.db.select().from(users).where(eq(users.email, "ada@example.com"));
  const [credential] = await t.db
    .select()
    .from(credentials)
    .where(eq(credentials.userId, user?.id ?? ""));
  if (!user || !credential) throw new Error("no credential");
  const track = await t.request("/api/tracks", {
    method: "POST",
    cookie,
    body: JSON.stringify({ goal: TITLE }),
  });
  const { id: trackId } = (await track.json()) as { id: string };
  return { cookie, userId: user.id, trackId, sealedKey: credential.sealedKey };
}

const answer = (cookie: string, sessionId: string, text: string) =>
  t.request(`/api/sessions/${sessionId}/steps/s1/answer`, {
    method: "POST",
    cookie,
    body: JSON.stringify({ text }),
  });

describe("logs", () => {
  it("never show a key, the session cookie or anyone's words during a session run", async () => {
    const captured = logs();
    const { cookie, userId, trackId, sealedKey } = await keyedLearner();

    // The probe, the plan, the lesson.
    models.script("probe", { text: FIRST_QUESTION });
    const started = await t.request(`/api/tracks/${trackId}/sessions`, { method: "POST", cookie });
    const { id: sessionId } = (await started.json()) as { id: string };
    await until(cookie, sessionId, (s) => s.messages.length === 1 && !s.messages[0]?.streaming);
    finishProbe(models);
    models.script("plan", planAttempt(PLAN_TEXT, PLAN_ACTIONS));
    await t.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ text: PROBE_ANSWER }),
    });
    await until(cookie, sessionId, (s) => s.state.plan === "proposed");
    models.script("lesson", { text: LESSON, thenGenerate: [JSON.stringify(OUTLINE)] });
    await t.request(`/api/sessions/${sessionId}/approve-plan`, { method: "POST", cookie });
    await until(cookie, sessionId, (s) => s.lesson?.steps.length === 2);

    // A check whose reply isn't the verdict's JSON: an SDK error that quotes the model's output.
    models.script("check", { thenGenerate: [`Wombat: ${CHECK_ANSWER}, you say? Good.`] });
    expect((await answer(cookie, sessionId, CHECK_ANSWER)).status).toBe(202);
    const replies = (n: number) => (s: Snapshot) =>
      s.checks.filter((m) => m.role === "tutor").length === n;
    await until(cookie, sessionId, replies(1));

    // A provider failure, whose error carries the request: the prompt, with the answer in it.
    models.script(
      "check",
      new MockLanguageModelV4({
        doGenerate: () =>
          Promise.reject(
            new APICallError({
              message: "The server had an error",
              url: "https://api.openai.com/v1/responses",
              requestBodyValues: { input: [{ role: "user", content: CHECK_ANSWER }] },
              statusCode: 500,
              responseBody: JSON.stringify({ error: { type: "server_error" } }),
              isRetryable: false,
            }),
          ),
      }),
    );
    expect((await answer(cookie, sessionId, CHECK_ANSWER)).status).toBe(202);
    await until(cookie, sessionId, replies(2));

    models.script("check", {
      thenGenerate: [
        JSON.stringify({
          verdict: "landed",
          reply: "Right.",
          actions: [],
          freshQuestion: null,
          alreadyHeld: null,
          note: null,
        }),
      ],
    });
    expect((await answer(cookie, sessionId, CHECK_ANSWER)).status).toBe(202);
    await until(cookie, sessionId, (s) => s.state.currentStep === "s2");
    // The job logs that it finished after the state it wrote, so wait for the line itself.
    await t.waitFor(() =>
      Promise.resolve(
        withMsg(captured.lines, "job finished").filter((l) => l.task === "check").length > 0,
      ),
    );

    const { lines } = captured;
    const text = captured.text();
    // What was logged: requests, jobs, model calls and state changes, by id.
    expect(withMsg(lines, "request").length).toBeGreaterThan(5);
    expect(withMsg(lines, "job finished").map((l) => l.task)).toEqual(
      expect.arrayContaining(["probe-turn", "plan", "lesson", "check"]),
    );
    expect(withMsg(lines, "model call").map((l) => l.purpose)).toEqual(
      expect.arrayContaining(["probe", "probe-decision", "plan", "lesson", "check"]),
    );
    expect(withMsg(lines, "model call failed")).toEqual([
      expect.objectContaining({
        sessionId,
        userId,
        trackId,
        purpose: "check",
        err: expect.objectContaining({ status: 500 }) as unknown,
      }),
    ]);
    expect(withMsg(lines, "job failed").map((l) => [l.task, l.handled, l.level])).toEqual([
      ["check", undefined, "error"],
      ["check", true, "warn"],
    ]);
    expect(withMsg(lines, "session state changed").map((l) => l.event)).toEqual(
      expect.arrayContaining(["learner-message", "probe-done", "plan-proposed", "check-verdict"]),
    );

    // What never was.
    for (const secret of [
      KEY,
      sealedKey,
      cookie.replace(/^[^=]+=/, ""),
      TITLE,
      PROBE_ANSWER,
      CHECK_ANSWER,
      FIRST_QUESTION,
      PLAN_TEXT,
    ])
      expect(text).not.toContain(secret);
    expect(text).not.toMatch(WORDS);

    // The database, unlike the log, keeps what each call was sent and answered (design §4.2), with
    // the validators' verdict where they judged the reply; never the key.
    const calls = await t.db
      .select({ purpose: usageEvents.purpose, call: modelCalls })
      .from(modelCalls)
      .innerJoin(usageEvents, eq(usageEvents.id, modelCalls.usageEventId));
    const stored = JSON.stringify(calls);
    for (const said of [TITLE, PROBE_ANSWER, CHECK_ANSWER, FIRST_QUESTION, PLAN_TEXT])
      expect(stored).toContain(said);
    for (const secret of [KEY, sealedKey.ciphertext, cookie.replace(/^[^=]+=/, "")])
      expect(stored).not.toContain(secret);
    expect(calls.find((c) => c.purpose === "probe")?.call.verdict).toEqual({
      rewrite: 0,
      issues: [],
    });
  });
});

describe("request lines", () => {
  it("give the method, route, status and time, with the reason for a refusal", async () => {
    const captured = logs();
    await invite(t.db, "ada@example.com");
    const cookie = await t.signIn("ada@example.com");
    const response = await t.request("/api/sessions/not-a-session", { cookie });
    expect(response.status).toBe(404);

    expect(withMsg(captured.lines, "request refused")).toEqual([
      expect.objectContaining({
        level: "warn",
        requestId: response.headers.get("x-request-id"),
        userId: expect.any(String) as string,
        method: "GET",
        route: "/api/sessions/:id",
        path: "/api/sessions/not-a-session",
        status: 404,
        reason: "not-found",
        durationMs: expect.any(Number) as number,
      }),
    ]);
  });

  it("never give the query string: a token or a learner's words would travel in it", async () => {
    const captured = logs();
    await invite(t.db, "ada@example.com");
    const cookie = await t.signIn("ada@example.com");
    await t.request("/api/credentials?token=n0t-f0r-the-l0g", { cookie });

    expect(withMsg(captured.lines, "request").map((l) => l.path)).toContain("/api/credentials");
    expect(captured.text()).not.toContain("n0t-f0r-the-l0g");
  });

  it("carry the request id into the jobs it queues", async () => {
    const captured = logs();
    const { cookie, trackId } = await keyedLearner();
    models.script("probe", { text: FIRST_QUESTION });
    const started = await t.request(`/api/tracks/${trackId}/sessions`, { method: "POST", cookie });
    const { id: sessionId } = (await started.json()) as { id: string };
    await t.waitFor(() =>
      Promise.resolve(
        withMsg(captured.lines, "job finished").some((l) => l.sessionId === sessionId),
      ),
    );

    const requestId = started.headers.get("x-request-id");
    const job = captured.lines.filter((l) => l.task === "probe-turn");
    expect(job.map((l) => l.message)).toEqual(
      expect.arrayContaining(["job started", "model call", "job finished"]),
    );
    for (const line of job)
      expect(line).toMatchObject({ requestId, sessionId, jobId: expect.any(String) as string });
  });
});
