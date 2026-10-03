import type { CallDetail, LearnerRow, Overview, Replay, SessionRow } from "@grounded/core/admin";
import { eq, users } from "@grounded/db";
import { beforeEach, describe, expect, it } from "vitest";
import { listInvited, setOperator } from "./allowlist.js";
import { createFlows } from "./test/flows.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";
import { throughTheCaller } from "./test/stored-models.js";

// The admin panel's routes (design §10.1), read over a real session: the scripted models are called
// through the real model caller, so every call is recorded and stored as in production.
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

/** A learner's session with its first check missed once, then landed. */
async function taughtSession() {
  const session = await planned();
  const { cookie, sessionId } = session;
  models.script("lesson", { text: LESSON, thenGenerate: [JSON.stringify(OUTLINE)] });
  await t.request(`/api/sessions/${sessionId}/approve-plan`, { method: "POST", cookie });
  await until(cookie, sessionId, (s) => s.lesson?.steps.length === 2);

  models.script("check", {
    thenGenerate: [
      graded({
        verdict: "missed",
        reply: "Close. Memory keeps the old value.",
        freshQuestion: "Two workers each copy 10. What does memory hold?",
      }),
    ],
  });
  const answer = (text: string) =>
    t.request(`/api/sessions/${sessionId}/steps/s1/answer`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ text }),
    });
  await answer("the new value");
  await until(cookie, sessionId, (s) => s.checks.filter((m) => m.verdict).length === 1);
  models.script("check", { thenGenerate: [graded({ verdict: "landed" })] });
  await answer("10, until one of them puts its copy back");
  await until(cookie, sessionId, (s) => s.checks.filter((m) => m.verdict).length === 2);
  return session;
}

/** Omer, signed in and made an operator. */
async function operator() {
  const cookie = await t.signIn("omer@example.com");
  await setOperator(t.db, "omer@example.com", true);
  return cookie;
}

/** The number a learner is named by: numbers are never reused, so they run on across tests. */
const numberOf = async (email: string) => {
  const [row] = await t.db
    .select({ n: users.learnerNumber })
    .from(users)
    .where(eq(users.email, email));
  if (!row) throw new Error(`${email} has no user`);
  return row.n;
};

const get = async <T>(cookie: string, path: string) => {
  const response = await t.request(path, { cookie });
  expect(response.status).toBe(200);
  return (await response.json()) as T;
};

describe("the admin panel", () => {
  it("is there only for operators: anyone else is answered as if it weren't", async () => {
    const learner = await t.signIn("ada@example.com");
    for (const path of ["/api/admin/me", "/api/admin/overview", "/api/admin/sessions"])
      expect((await t.request(path, { cookie: learner })).status).toBe(404);
    expect((await t.request("/api/admin/overview")).status).toBe(401);

    const cookie = await operator();
    expect(await get(cookie, "/api/admin/me")).toEqual({ email: "omer@example.com" });
    const marked = (await listInvited(t.db)).map((row) => [row.email, row.operator]);
    expect(marked).toEqual([
      ["ada@example.com", false],
      ["omer@example.com", true],
    ]);

    expect(await setOperator(t.db, " Omer@Example.com", false)).toBe(true);
    expect((await t.request("/api/admin/me", { cookie })).status).toBe(404);
    expect(await setOperator(t.db, "nobody@example.com", true)).toBe(false);
  });

  it("lists sessions by the learner's number, with how their checks went and their calls", async () => {
    const { sessionId, trackId } = await taughtSession();
    const cookie = await operator();
    const ada = await numberOf("ada@example.com");

    const { sessions } = await get<{ sessions: SessionRow[] }>(cookie, "/api/admin/sessions");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: sessionId,
      learner: ada,
      trackId,
      kind: "normal",
      phase: "lesson",
      checked: 1,
      firstTry: 0,
      misses: 1,
      models: ["gpt-6-luna"],
      errors: 0,
    });
    expect(JSON.stringify(sessions)).not.toContain("ada@example.com");
    expect(sessions[0]?.calls).toBeGreaterThan(0);

    const filtered = async (query: string) =>
      (await get<{ sessions: SessionRow[] }>(cookie, `/api/admin/sessions?${query}`)).sessions;
    expect(await filtered("has=misses")).toHaveLength(1);
    expect(await filtered("has=asides")).toHaveLength(0);
    expect(await filtered(`learner=${String(ada)}`)).toHaveLength(1);
    expect(await filtered(`learner=${String(ada + 1)}`)).toHaveLength(0);
    expect(await filtered("phase=lesson")).toHaveLength(1);
    expect(await filtered("method=000000000000")).toHaveLength(0);
    expect(await filtered("model=gpt-6-luna")).toHaveLength(1);
  });

  it("replays a session in time order, with each call behind it and the call in full", async () => {
    const { sessionId } = await taughtSession();
    const cookie = await operator();

    const ada = await numberOf("ada@example.com");

    const replay = await get<Replay>(cookie, `/api/admin/sessions/${sessionId}`);
    expect(replay.session).toMatchObject({ learner: ada, phase: "lesson" });
    expect(replay.track.goal).toBe("Concurrency");
    const kinds = replay.timeline.map((item) => item.kind);
    for (const kind of ["message", "phase", "outline", "step", "check", "call"])
      expect(kinds).toContain(kind);
    const times = replay.timeline.map((item) => item.at);
    expect(times).toEqual([...times].sort());

    const steps = replay.timeline.flatMap((item) => (item.kind === "step" ? [item] : []));
    expect(steps.map((s) => s.heading)).toEqual(["Adding one is three moves", "Two workers"]);
    expect(steps[0]?.text).toContain("[word: working copy]");
    expect(steps[0]?.text).toContain("[check]");
    const verdicts = replay.timeline.flatMap((item) =>
      item.kind === "check" && item.verdict ? [item.verdict] : [],
    );
    expect(verdicts).toEqual(["missed", "landed"]);
    expect(replay.lesson?.steps[0]).toMatchObject({ id: "s1", status: "passed" });

    const calls = replay.timeline.flatMap((item) => (item.kind === "call" ? [item.call] : []));
    const check = calls.find((call) => call.purpose === "check");
    expect(check).toMatchObject({ model: "gpt-6-luna", status: "ok", stored: true });
    expect(check?.methodVersion).toMatch(/^[0-9a-f]{12}$/);

    const detail = await get<CallDetail>(cookie, `/api/admin/calls/${check?.id ?? ""}`);
    expect(detail).toMatchObject({ purpose: "check", learner: ada, sessionId });
    expect(detail.content?.prompt.length).toBeGreaterThan(1);
    expect(JSON.stringify(detail.content?.prompt)).toContain("the new value");
    expect(JSON.stringify(detail.content?.reply)).toContain("Memory keeps the old value");
  });

  it("sums up where the teaching broke", async () => {
    await taughtSession();
    const cookie = await operator();

    const o = await get<Overview>(cookie, "/api/admin/overview?period=all");
    expect(o.totals).toMatchObject({ learners: 1, sessions: 1, closed: 0 });
    expect(o.totals.calls).toBeGreaterThan(0);
    expect(o.checks).toMatchObject({ checked: 1, firstTry: 0, misses: 1, settling: 0 });
    expect(o.checks.byModel).toEqual([{ model: "gpt-6-luna", checked: 1, firstTry: 0, misses: 1 }]);
    expect(o.validators.byPurpose.some((v) => v.purpose === "check" && v.judged === 2)).toBe(true);
    expect(o.sessions.furthest).toEqual([{ phase: "lesson", sessions: 1 }]);
    expect(o.sessions.plans).toEqual([{ plans: 1, sessions: 1 }]);
    expect(o.calls.byPurpose.map((p) => p.purpose)).toContain("lesson");
    expect(o.failures.calls).toEqual([]);

    const none = await get<Overview>(cookie, "/api/admin/overview?method=000000000000");
    expect(none.totals).toMatchObject({ sessions: 0, calls: 0 });
  });

  it("names learners by number, and gives an email only when asked", async () => {
    await taughtSession();
    const cookie = await operator();
    const [ada, omer] = [await numberOf("ada@example.com"), await numberOf("omer@example.com")];

    const learners = await get<LearnerRow[]>(cookie, "/api/admin/learners");
    expect(learners.map((l) => [l.learner, l.sessions, l.tracks.map((tr) => tr.title)])).toEqual([
      [ada, 1, ["Concurrency"]],
      [omer, 0, []],
    ]);
    expect(JSON.stringify(learners)).not.toContain("@example.com");
    expect(await get(cookie, `/api/admin/learners/${String(ada)}/email`)).toEqual({
      email: "ada@example.com",
    });
    const nobody = String(omer + 1);
    expect((await t.request(`/api/admin/learners/${nobody}/email`, { cookie })).status).toBe(404);
  });
});
