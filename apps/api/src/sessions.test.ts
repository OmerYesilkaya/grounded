import { eq, sessionMessages, terms, users } from "@grounded/db";
import { beforeEach, describe, expect, it } from "vitest";
import { invite } from "./allowlist.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";
import { readSse } from "./test/sse.js";

const models = scriptedModels();
const t = createTestHarness({ models: models.access });

beforeEach(() => {
  models.reset();
});

interface Snapshot {
  state: { phase: string; plan: string };
  messages: {
    role: string;
    kind: string;
    text: string | null;
    blocks: { type: string }[] | null;
  }[];
}

async function learner() {
  await invite(t.db, "ada@example.com");
  const cookie = await t.signIn("ada@example.com");
  const track = (await (
    await t.request("/api/tracks", {
      method: "POST",
      cookie,
      body: JSON.stringify({ title: "Concurrency" }),
    })
  ).json()) as {
    id: string;
  };
  return { cookie, trackId: track.id };
}

const snapshot = async (cookie: string, sessionId: string) =>
  (await (await t.request(`/api/sessions/${sessionId}`, { cookie })).json()) as Snapshot;

const until = (cookie: string, sessionId: string, ok: (s: Snapshot) => boolean) =>
  t.waitFor(async () => ok(await snapshot(cookie, sessionId)));

const FIRST_QUESTION = "In your own words: what happens when a program adds one to a number?";
const PLAN_TEXT =
  "We start from what you already hold and build towards why a counter can lose updates.";
const PLAN_ACTIONS = [
  { type: "add-planned-term", term: "working copy", restsOn: [] },
  { type: "add-planned-term", term: "lost update", restsOn: ["working copy"] },
  {
    type: "set-plan",
    arcs: [{ title: "Concurrency", terms: ["working copy", "lost update"] }],
    notes: "",
  },
];

async function startedSession() {
  const { cookie, trackId } = await learner();
  models.script("probe", { text: FIRST_QUESTION });
  const started = await t.request(`/api/tracks/${trackId}/sessions`, { method: "POST", cookie });
  expect(started.status).toBe(201);
  const { id } = (await started.json()) as { id: string };
  await until(cookie, id, (s) => s.messages.length === 1);
  return { cookie, trackId, sessionId: id };
}

async function planned() {
  const session = await startedSession();
  models.script("probe", {
    text: "Thanks, that's clear.",
    calls: [
      {
        name: "record",
        input: { actions: [{ type: "add-fix-item", text: "Thinks adding one is a single step" }] },
      },
      { name: "finish_probe", input: { summary: "Floor: variables. Goal: counters under load." } },
    ],
  });
  models.script("plan", {
    text: PLAN_TEXT,
    calls: [{ name: "propose_plan", input: { actions: PLAN_ACTIONS } }],
  });
  await t.request(`/api/sessions/${session.sessionId}/messages`, {
    method: "POST",
    cookie: session.cookie,
    body: JSON.stringify({ text: "it just adds one" }),
  });
  await until(session.cookie, session.sessionId, (s) => s.state.plan === "proposed");
  return session;
}

describe("starting a session", () => {
  it("opens with the tutor's first probe question, streamed", async () => {
    const { cookie, sessionId } = await startedSession();
    const s = await snapshot(cookie, sessionId);
    expect(s.state.phase).toBe("probe");
    expect(s.messages).toMatchObject([
      { role: "tutor", kind: "message", blocks: [{ type: "paragraph" }] },
    ]);

    const controller = new AbortController();
    const stream = readSse(
      await t.request(`/api/sessions/${sessionId}/stream`, { cookie, signal: controller.signal }),
    );
    const events = [];
    for (
      let e = (await stream.next(1))[0];
      e;
      e = e.event === "message-done" ? undefined : (await stream.next(1))[0]
    )
      events.push(e);
    controller.abort();
    expect(events[0]?.event).toBe("state");
    expect(events.map((e) => e.event)).toContain("message-start");
    const streamed = events
      .filter((e) => e.event === "message-delta")
      .map((e) => (e.data as { text: string }).text);
    expect(streamed.join("")).toBe(FIRST_QUESTION);
  });

  it("allows one open session per track", async () => {
    const { cookie, trackId, sessionId } = await startedSession();
    const again = await t.request(`/api/tracks/${trackId}/sessions`, { method: "POST", cookie });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: "This track already has an open session.",
      sessionId,
    });
  });
});

describe("probe and plan", () => {
  it("moves to the plan when the tutor finishes probing, and records the plan's terms", async () => {
    const { cookie, sessionId } = await planned();
    const s = await snapshot(cookie, sessionId);
    expect(s.state).toMatchObject({ phase: "plan", plan: "proposed" });
    expect(s.messages.map((m) => [m.role, m.kind])).toEqual([
      ["tutor", "message"],
      ["learner", "message"],
      ["tutor", "message"],
      ["tutor", "plan"],
    ]);
    const stored = await t.db.select().from(terms);
    expect(stored.map((row) => [row.term, row.status])).toEqual([
      ["working copy", "planned"],
      ["lost update", "planned"],
    ]);
  });

  it("lets the learner skip ahead to the plan", async () => {
    const { cookie, sessionId } = await startedSession();
    models.script("plan", {
      text: PLAN_TEXT,
      calls: [{ name: "propose_plan", input: { actions: PLAN_ACTIONS } }],
    });
    expect(
      (await t.request(`/api/sessions/${sessionId}/skip-to-plan`, { method: "POST", cookie }))
        .status,
    ).toBe(200);
    await until(cookie, sessionId, (s) => s.state.plan === "proposed");
  });

  it("retracts a plan whose terms can't be recorded, and asks again with the reasons", async () => {
    const { cookie, sessionId } = await startedSession();
    const bad = [{ type: "add-planned-term", term: "lost update", restsOn: ["working copy"] }];
    models.script(
      "plan",
      {
        text: "A plan resting on something missing.",
        calls: [{ name: "propose_plan", input: { actions: bad } }],
      },
      { text: PLAN_TEXT, calls: [{ name: "propose_plan", input: { actions: PLAN_ACTIONS } }] },
    );
    await t.request(`/api/sessions/${sessionId}/skip-to-plan`, { method: "POST", cookie });
    await until(cookie, sessionId, (s) => s.state.plan === "proposed");

    const plans = (await snapshot(cookie, sessionId)).messages.filter((m) => m.kind === "plan");
    expect(plans).toHaveLength(1);
    const secondPrompt = JSON.stringify(
      models.used.filter((u) => u.purpose === "plan")[1]?.model.doStreamCalls[0]?.prompt,
    );
    expect(secondPrompt).toContain("rests on");
  });

  it("revises the plan when the learner replies to it, then approves it into the lesson", async () => {
    const { cookie, sessionId } = await planned();
    models.script("plan", {
      text: "Revised: backend first.",
      calls: [
        {
          name: "propose_plan",
          input: {
            actions: [
              {
                type: "set-plan",
                arcs: [{ title: "Backend", terms: ["lost update"] }],
                notes: "Reordered at the learner's request.",
              },
            ],
          },
        },
      ],
    });
    await t.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ text: "Can we do backend first?" }),
    });
    await until(
      cookie,
      sessionId,
      (s) =>
        s.state.plan === "proposed" && s.messages.filter((m) => m.kind === "plan").length === 2,
    );

    const approved = await t.request(`/api/sessions/${sessionId}/approve-plan`, {
      method: "POST",
      cookie,
    });
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as Snapshot).state.phase).toBe("lesson");
  });

  it("answers an out-of-order action with the state machine's reason", async () => {
    const { cookie, sessionId } = await startedSession();
    const early = await t.request(`/api/sessions/${sessionId}/approve-plan`, {
      method: "POST",
      cookie,
    });
    expect(early.status).toBe(409);
    expect(await early.json()).toEqual({ error: "There is no plan to approve yet." });
  });

  it("rewrites a probe message that breaks the chat's rules before storing it", async () => {
    const { cookie, trackId } = await learner();
    const withDrawing =
      "Look at this:\n\n```diagram\ncaption: c\n---\nflowchart TB\n  A\n```\n\nWhat do you see?";
    models.script("probe", {
      text: withDrawing,
      thenGenerate: ["What do you think happens first?"],
    });
    const { id } = (await (
      await t.request(`/api/tracks/${trackId}/sessions`, { method: "POST", cookie })
    ).json()) as { id: string };
    await until(cookie, id, (s) => s.messages.length === 1);

    const [message] = await t.db
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, id));
    expect(message?.text).toBe("What do you think happens first?");
    expect(message?.blocks?.map((b) => b.type)).toEqual(["paragraph"]);
    const [user] = await t.db.select().from(users);
    expect(user).toBeDefined();
  });
});
