import { invite } from "./allowlist.js";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { asc, eq, sessionEvents, sessionMessages, terms, tracks, users } from "@grounded/db";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { startActivity } from "./engine/events.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";
import { readSse } from "./test/sse.js";
import {
  createFlows,
  storedMessages,
  FIRST_QUESTION,
  PLAN_ACTIONS,
  PLAN_TEXT,
  PROBE_SUMMARY,
  planAttempt,
  probeFinished,
  probeGoesOn,
  type Snapshot,
} from "./test/flows.js";

const models = scriptedModels();
const t = createTestHarness({ models: models.access });

beforeEach(() => {
  models.reset();
});

const { snapshot, until, learner, startedSession, planned, activities } = createFlows(t, models);

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

  it("retracts a tutor message the model fails part-way through", async () => {
    const { cookie, trackId } = await learner();
    // The connection to the provider drops after the first words.
    const dropping = new MockLanguageModelV4({
      doStream: {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({ type: "text-delta", id: "t", delta: "In your own words" });
            controller.error(new Error("socket hang up"));
          },
        }),
      },
    });
    models.script("probe", dropping);
    const started = await t.request(`/api/tracks/${trackId}/sessions`, { method: "POST", cookie });
    const { id: sessionId } = (await started.json()) as { id: string };

    const types = async () =>
      (
        await t.db
          .select({ type: sessionEvents.type })
          .from(sessionEvents)
          .where(eq(sessionEvents.sessionId, sessionId))
          .orderBy(asc(sessionEvents.id))
      ).map((e) => e.type);
    await t.waitFor(async () => (await types()).includes("error"));
    expect(await types()).toEqual([
      "state",
      "message-start",
      "activity", // Thinking… starts
      "activity", // and ends as the text starts
      "message-retracted",
      "error",
    ]);
    expect((await snapshot(cookie, sessionId)).messages).toEqual([]);
  });
});

describe("where you left off", () => {
  const LEFT_OFF = "Open thread: why the counter lost updates. Owed: the counter homework.";
  const withNotes = async (notes: string) => {
    const { cookie, trackId } = await learner();
    await t.db
      .update(tracks)
      .set({ plan: { arcs: [], notes } })
      .where(eq(tracks.id, trackId));
    return { cookie, trackId };
  };
  const open = async (cookie: string, trackId: string) => {
    const started = await t.request(`/api/tracks/${trackId}/sessions`, { method: "POST", cookie });
    const { id } = (await started.json()) as { id: string };
    await until(cookie, id, storedMessages(1));
    return models.used.find((u) => u.purpose === "probe")?.model.doStreamCalls[0]?.prompt;
  };

  it("is written from long notes that have none yet, before the opening question, which carries it instead", async () => {
    const notes = `Imported notes. ${"A long session log line. ".repeat(400)}`;
    const { cookie, trackId } = await withNotes(notes);
    models.script("left-off", { text: LEFT_OFF });
    models.script("probe", { text: FIRST_QUESTION });
    const prompt = JSON.stringify(await open(cookie, trackId));

    const reading = models.used.find((u) => u.purpose === "left-off")?.model.doGenerateCalls[0];
    expect(JSON.stringify(reading?.prompt)).toContain("Imported notes.");
    expect(prompt).toContain(`### Where you left off\\n\\n${LEFT_OFF}`);
    expect(prompt).not.toContain("Imported notes.");
    const [track] = await t.db.select().from(tracks).where(eq(tracks.id, trackId));
    expect(track?.leftOff).toBe(LEFT_OFF);
    expect(track?.plan.notes).toBe(notes);
  });

  it("isn't written for short notes: they are carried as written until the first close", async () => {
    const { cookie, trackId } = await withNotes("Reordered: backend first.");
    models.script("probe", { text: FIRST_QUESTION });
    expect(JSON.stringify(await open(cookie, trackId))).toContain("Reordered: backend first.");
    expect(models.used.map((u) => u.purpose)).toEqual(["probe"]);
  });

  it("falls back to the notes as written when it can't be written", async () => {
    const { cookie, trackId } = await withNotes(`Imported notes. ${"A line. ".repeat(800)}`);
    // No "left-off" model: the call fails.
    models.script("probe", { text: FIRST_QUESTION });
    expect(JSON.stringify(await open(cookie, trackId))).toContain("Imported notes.");
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
      ["tutor", "plan"],
    ]);
    const stored = await t.db.select().from(terms);
    expect(stored.map((row) => [row.term, row.status])).toEqual([
      ["working copy", "planned"],
      ["lost update", "planned"],
    ]);
  });

  it("opens the probe from what the learner said they want to learn", async () => {
    await startedSession();
    const opening = models.used.find((u) => u.purpose === "probe")?.model.doStreamCalls[0];
    expect(JSON.stringify(opening?.prompt)).toContain(
      "The learner started a session. They said they want to learn: Concurrency",
    );
  });

  it("decides first, then writes the next question with what the answers showed", async () => {
    const { cookie, sessionId } = await startedSession();
    models.script("probe-decision", probeGoesOn([{ type: "set-language", language: "German" }]));
    models.script("probe", { text: "Verstanden. Was steht im Speicher, während das passiert?" });
    await t.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ text: "es addiert einfach eins" }),
    });
    await until(cookie, sessionId, storedMessages(3));

    expect((await activities(sessionId)).map((a) => a.label).slice(1)).toEqual([
      "Noting what your answers showed",
      "Thinking…",
    ]);
    expect(models.used.map((u) => u.purpose)).toEqual(["probe", "probe-decision", "probe"]);
    const [, decision, question] = models.used.map((u) => u.model);
    expect(JSON.stringify(decision?.doGenerateCalls[0]?.prompt)).not.toContain("Verstanden");
    expect(JSON.stringify(question?.doStreamCalls[0]?.prompt)).toContain(
      "Teaching language: German",
    );
    expect((await snapshot(cookie, sessionId)).state.phase).toBe("probe");
  });

  it("writes no probe message on the turn that ends the probe: the plan is in the plan message", async () => {
    const { cookie, sessionId } = await startedSession();
    // A model that feels done would present the plan in its probe message, if it were asked for one.
    models.script("probe-decision", probeFinished());
    models.script("probe", {
      text: "Here's a plan aimed at your goal: first memory, then lost updates. Does that cover it?",
    });
    models.script("plan", planAttempt(PLAN_TEXT));
    await t.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ text: "it just adds one; I want to know why my counter is off" }),
    });
    await until(cookie, sessionId, (s) => s.state.plan === "proposed");

    const stored = await t.db
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(asc(sessionMessages.createdAt), asc(sessionMessages.id));
    expect(stored.map((m) => [m.role, m.kind, m.text])).toEqual([
      ["tutor", "message", FIRST_QUESTION],
      ["learner", "message", "it just adds one; I want to know why my counter is off"],
      ["tutor", "plan", PLAN_TEXT],
    ]);
    // Only the opening question was written by the probe's model.
    expect(models.used.filter((u) => u.purpose === "probe")).toHaveLength(1);
  });

  it("gives the plan the probe's conclusion", async () => {
    await planned();
    const planCall = models.used.find((u) => u.purpose === "plan")?.model.doStreamCalls[0];
    expect(JSON.stringify(planCall?.prompt)).toContain(PROBE_SUMMARY);
  });

  it("lets the learner skip ahead to the plan", async () => {
    const { cookie, sessionId } = await startedSession();
    models.script("plan", planAttempt(PLAN_TEXT));
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
      planAttempt("A plan resting on something missing.", bad),
      planAttempt(PLAN_TEXT),
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
    models.script(
      "plan",
      planAttempt("Revised: backend first.", [
        {
          type: "set-plan",
          arcs: [{ title: "Backend", terms: ["lost update"] }],
          notes: "Reordered at the learner's request.",
        },
      ]),
    );
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

  it("researches with web search before the first plan, in its own call", async () => {
    const { cookie, sessionId } = await startedSession();
    models.enableSearch();
    models.script(
      "plan",
      {
        searches: ["lost update"],
        text: "NOTES: a lost update is when one write overwrites another.",
      },
      planAttempt(PLAN_TEXT),
    );
    await t.request(`/api/sessions/${sessionId}/skip-to-plan`, { method: "POST", cookie });
    await until(cookie, sessionId, (s) => s.state.plan === "proposed");

    const [researcher, planner] = models.used.filter((u) => u.purpose === "plan");
    expect(researcher?.model.doStreamCalls[0]?.tools?.map((tool) => tool.name)).toEqual([
      "web_search",
    ]);
    const planCall = planner?.model.doStreamCalls[0];
    expect(planCall?.tools).toBeUndefined();
    expect(JSON.stringify(planCall?.prompt)).toContain("NOTES: a lost update");
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
    await until(cookie, id, storedMessages(1));

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

describe("creating a track", () => {
  it("doesn't ask for a language: the tutor infers it", async () => {
    await invite(t.db, "bo@example.com");
    const cookie = await t.signIn("bo@example.com");
    const created = await t.request("/api/tracks", {
      method: "POST",
      cookie,
      body: JSON.stringify({ title: "Geometry" }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ title: "Geometry", language: null });
  });
});

describe("empty replies", () => {
  const storedTutorTexts = async (sessionId: string) =>
    (await t.db.select().from(sessionMessages).where(eq(sessionMessages.sessionId, sessionId)))
      .filter((m) => m.role === "tutor")
      .map((m) => m.text);

  it("asks again when a probe reply is only a tool call, and never stores it empty", async () => {
    const { cookie, sessionId } = await startedSession();
    models.script("probe-decision", probeGoesOn());
    models.script("probe", {
      calls: [{ name: "finish_probe", input: { summary: "Floor: variables." } }],
      thenStream: [{ text: "Got it. What does memory hold while that happens?" }],
    });
    await t.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ text: "it just adds one" }),
    });
    await until(cookie, sessionId, storedMessages(3));

    expect(await storedTutorTexts(sessionId)).toEqual([
      FIRST_QUESTION,
      "Got it. What does memory hold while that happens?",
    ]);
    const probe = models.used.filter((u) => u.purpose === "probe")[1]?.model;
    expect(probe?.doStreamCalls.map((call) => call.tools)).toEqual([undefined, undefined]);
    expect(JSON.stringify(probe?.doStreamCalls[1]?.prompt)).toContain("had no text");
    expect((await snapshot(cookie, sessionId)).state.phase).toBe("probe");
  });

  it("asks again when the plan's prose comes back empty, then records the plan", async () => {
    const { cookie, sessionId } = await startedSession();
    models.script("plan", {
      reasoning: "The plan should start from memory.",
      thenStream: [{ text: PLAN_TEXT }],
      thenGenerate: [JSON.stringify({ actions: PLAN_ACTIONS })],
    });
    await t.request(`/api/sessions/${sessionId}/skip-to-plan`, { method: "POST", cookie });
    await until(cookie, sessionId, (s) => s.state.plan === "proposed");

    expect(await storedTutorTexts(sessionId)).toEqual([FIRST_QUESTION, PLAN_TEXT]);
    const stored = await t.db.select().from(terms);
    expect(stored.map((row) => row.term)).toEqual(["working copy", "lost update"]);
  });

  it("retracts the message and says so when every attempt is empty", async () => {
    const { cookie, sessionId } = await startedSession();
    models.script("probe-decision", probeGoesOn());
    models.script("probe", { text: " ", thenStream: [{ text: "\n" }, {}] });
    await t.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ text: "it just adds one" }),
    });
    const events = async () =>
      t.db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, sessionId));
    await t.waitFor(async () => (await events()).some((e) => e.type === "error"));

    const log = await events();
    const started = log.filter((e) => e.type === "message-start").at(-1)?.data as { id: string };
    expect(log.map((e) => e.type)).toContain("message-retracted");
    expect(log.find((e) => e.type === "message-retracted")?.data).toEqual({ id: started.id });
    expect(log.find((e) => e.type === "error")?.data).toEqual({
      message: "The tutor's reply came back empty. Try again.",
    });
    expect(await storedTutorTexts(sessionId)).toEqual([FIRST_QUESTION]);
  });
});

describe("activity", () => {
  const labels = async (sessionId: string) => (await activities(sessionId)).map((a) => a.label);
  const allDone = async (sessionId: string) =>
    (await activities(sessionId)).every((a) => a.state === "done");

  it("says what the tutor is doing through the probe and the plan, and ends every step", async () => {
    const { cookie, sessionId } = await planned();
    expect(await labels(sessionId)).toEqual([
      "Thinking…",
      "Noting what your answers showed",
      "Thinking…",
      "Recording the plan's terms",
    ]);
    expect(await allDone(sessionId)).toBe(true);
    expect((await snapshot(cookie, sessionId)).activities).toEqual([]);
  });

  it("says when a plan that didn't fit is being revised", async () => {
    const { cookie, sessionId } = await startedSession();
    const bad = [{ type: "add-planned-term", term: "lost update", restsOn: ["working copy"] }];
    models.script("plan", planAttempt("A plan resting on a gap.", bad), planAttempt(PLAN_TEXT));
    await t.request(`/api/sessions/${sessionId}/skip-to-plan`, { method: "POST", cookie });
    await until(cookie, sessionId, (s) => s.state.plan === "proposed");

    expect((await labels(sessionId)).slice(1)).toEqual([
      "Thinking…",
      "Recording the plan's terms",
      "Revising the plan (the first draft didn't fit)",
      "Thinking…",
      "Recording the plan's terms",
    ]);
    expect(await allDone(sessionId)).toBe(true);
  });

  it("shows the research and each web search", async () => {
    const { cookie, sessionId } = await startedSession();
    models.enableSearch();
    models.script(
      "plan",
      { searches: ["lost update", "read-modify-write"], text: "NOTES." },
      planAttempt(PLAN_TEXT),
    );
    await t.request(`/api/sessions/${sessionId}/skip-to-plan`, { method: "POST", cookie });
    await until(cookie, sessionId, (s) => s.state.plan === "proposed");

    expect((await labels(sessionId)).slice(1, 4)).toEqual([
      "Researching the subject",
      "Searching the web for “lost update”",
      "Searching the web for “read-modify-write”",
    ]);
    expect(await allDone(sessionId)).toBe(true);
  });

  it("passes the model's reasoning along, and says when it asks again for an empty reply", async () => {
    const { cookie, sessionId } = await startedSession();
    models.script("plan", {
      reasoning: "The plan should start from memory.",
      thenStream: [{ text: PLAN_TEXT }],
      thenGenerate: [JSON.stringify({ actions: PLAN_ACTIONS })],
    });
    await t.request(`/api/sessions/${sessionId}/skip-to-plan`, { method: "POST", cookie });
    await until(cookie, sessionId, (s) => s.state.plan === "proposed");

    const log = await activities(sessionId);
    expect(log.map((a) => a.label).slice(1, 3)).toEqual([
      "Thinking…",
      "Thinking again (the reply came back empty)",
    ]);
    const reasoning = await t.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.type, "activity-reasoning"));
    expect(reasoning.map((e) => e.data)).toEqual([
      { id: log[1]?.id, text: "The plan should start from memory." },
    ]);
  });

  it("lists what is still running in the snapshot, for a page opened mid-job", async () => {
    const { cookie, sessionId } = await startedSession();
    const outlining = await startActivity(t.db, sessionId, "Outlining the lesson");
    const writing = await startActivity(t.db, sessionId, "Writing step 1 of 3");
    await writing.update({ detail: "Adding one is three moves" });
    await outlining.done();

    expect((await snapshot(cookie, sessionId)).activities).toMatchObject([
      { label: "Writing step 1 of 3", detail: "Adding one is three moves", state: "running" },
    ]);
    await writing.done();
    expect((await snapshot(cookie, sessionId)).activities).toEqual([]);
  });
});
