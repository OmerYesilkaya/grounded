import { invite } from "./allowlist.js";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import {
  asc,
  eq,
  researchNotes,
  sessionEvents,
  sessionMessages,
  terms,
  tracks,
  users,
} from "@grounded/db";
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
  finishProbe,
  probeGoesOn,
  type Snapshot,
} from "./test/flows.js";

const models = scriptedModels();
/** The tutor's own calls, in order, without the wording reviews made on what it wrote. */
const tutorCalls = () => models.used.filter((u) => u.purpose !== "wording-review");
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
      error: { code: "session-open" },
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
    expect(tutorCalls().map((u) => u.purpose)).toEqual(["probe"]);
  });

  it("falls back to the notes as written when it can't be written", async () => {
    const { cookie, trackId } = await withNotes(`Imported notes. ${"A line. ".repeat(800)}`);
    // No "left-off" model: the call fails.
    models.script("probe", { text: FIRST_QUESTION });
    expect(JSON.stringify(await open(cookie, trackId))).toContain("Imported notes.");
  });
});

describe("a long session", () => {
  it("carries its older turns as a summary, and the last ones in full", async () => {
    const { cookie, sessionId } = await startedSession();
    // A long probe: 50 more exchanges of about 500 characters each.
    for (let i = 0; i < 100; i++) {
      await t.db.insert(sessionMessages).values({
        sessionId,
        role: i % 2 === 0 ? "learner" : "tutor",
        text: `Turn ${String(i)}. ${"Some words about counters and memory. ".repeat(13)}`,
      });
    }
    const SUMMARY = "Asked what adding one does; the learner said 'it copies, adds, puts back'.";
    models.script("conversation-summary", { text: SUMMARY });
    models.script("probe-decision", probeGoesOn());
    models.script("probe", { text: "What is in memory meanwhile?" });
    await t.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ text: "the last answer" }),
    });
    await until(cookie, sessionId, storedMessages(103));

    const summarizing = models.used.find((u) => u.purpose === "conversation-summary")?.model
      .doGenerateCalls[0];
    expect(JSON.stringify(summarizing?.prompt)).toContain(`Tutor: ${FIRST_QUESTION}`);
    const question = models.used.filter((u) => u.purpose === "probe")[1]?.model.doStreamCalls[0];
    const conversation = question?.prompt.filter((m) => m.role !== "system") ?? [];
    expect(JSON.stringify(conversation[0])).toContain(SUMMARY);
    expect(conversation).toHaveLength(1 + 10);
    expect(JSON.stringify(conversation.at(-1))).toContain("the last answer");
    expect(JSON.stringify(conversation)).not.toContain("Turn 0.");
    // Summarized once: the next calls reuse it until the rest grows past the limit again.
    expect(models.used.filter((u) => u.purpose === "conversation-summary")).toHaveLength(1);
  });
});

describe("probe and plan", () => {
  it("moves to the plan when the tutor finishes probing, and records the plan's terms", async () => {
    const { cookie, sessionId, trackId } = await planned();
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
    // A new track has no arcs: the first session's plan names the first one.
    const [track] = await t.db.select().from(tracks).where(eq(tracks.id, trackId));
    expect(track?.plan).toEqual({
      arcs: [{ title: "Concurrency", terms: ["working copy", "lost update"] }],
      notes: "",
    });
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
      { code: "noting-answers" },
      { code: "thinking", again: false },
    ]);
    expect(tutorCalls().map((u) => u.purpose)).toEqual(["probe", "probe-decision", "probe"]);
    const [, decision, question] = tutorCalls().map((u) => u.model);
    expect(JSON.stringify(decision?.doGenerateCalls[0]?.prompt)).not.toContain("Verstanden");
    expect(JSON.stringify(question?.doStreamCalls[0]?.prompt)).toContain(
      "Teaching language: German",
    );
    expect((await snapshot(cookie, sessionId)).state.phase).toBe("probe");
  });

  it("records what validates of the probe's edits, and asks once more for the rest, with the reasons", async () => {
    const { cookie, sessionId, trackId } = await startedSession();
    const decision = {
      actions: [
        { type: "set-language", language: "German" },
        { type: "set-term-status", term: "variable", status: "confirmed", evidence: "a box" },
      ],
      finished: false,
    };
    const corrected = [
      { type: "set-term-status", term: "variable", status: "assumed", evidence: "a box" },
    ];
    models.script("probe-decision", {
      thenGenerate: [JSON.stringify(decision), JSON.stringify({ actions: corrected })],
    });
    models.script("probe", { text: "Verstanden. Was steht im Speicher?" });
    await t.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ text: "a variable is a box" }),
    });
    await until(cookie, sessionId, storedMessages(3));

    const [track] = await t.db.select().from(tracks).where(eq(tracks.id, trackId));
    expect(track?.language).toBe("German");
    expect(
      (await t.db.select().from(terms).where(eq(terms.trackId, trackId))).map((r) => [
        r.term,
        r.status,
      ]),
    ).toEqual([["variable", "assumed"]]);
    const calls = models.used.find((u) => u.purpose === "probe-decision")?.model.doGenerateCalls;
    expect(JSON.stringify(calls?.[1]?.prompt)).toContain(
      "add it as a planned term first (or as assumed, if the learner already knew it)",
    );
  });

  it("writes no probe message on the turn that ends the probe: the plan is in the plan message", async () => {
    const { cookie, sessionId } = await startedSession();
    // A model that feels done would present the plan in its probe message, if it were asked for one.
    finishProbe(models);
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

  it("gives the plan the probe's conclusion, written by its own call after the decision", async () => {
    await planned();
    expect(tutorCalls().map((u) => u.purpose)).toEqual([
      "probe",
      "probe-decision",
      "probe-summary",
      "plan",
    ]);
    const summaryCall = models.used.find((u) => u.purpose === "probe-summary")?.model
      .doGenerateCalls[0];
    expect(JSON.stringify(summaryCall?.prompt)).toContain("it just adds one");
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
    const { cookie, sessionId, trackId } = await planned();
    models.script(
      "plan",
      planAttempt("Revised: backend first.", [
        { type: "add-planned-term", term: "request", restsOn: [] },
        // "lost update" was placed by the first draft: it stays where it is.
        { type: "add-to-arc", arc: "Backend", terms: ["request", "lost update"] },
        { type: "add-plan-notes", notes: "Reordered at the learner's request." },
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
    const [track] = await t.db.select().from(tracks).where(eq(tracks.id, trackId));
    expect(track?.plan).toEqual({
      arcs: [
        { title: "Concurrency", terms: ["working copy", "lost update"] },
        { title: "Backend", terms: ["request"] },
      ],
      notes: "Reordered at the learner's request.",
    });
  });

  describe("in a later session", () => {
    const ARCS = [
      { title: "A. Bits and memory", terms: ["bit", "memory"] },
      { title: "B. Programs", terms: ["program"] },
      { title: "C. Databases", terms: ["table"] },
      { title: "D. Networks", terms: ["packet"] },
    ];
    const planOn = async (actions: object[]) => {
      const { cookie, trackId } = await learner();
      await t.db.insert(terms).values(
        ARCS.flatMap((arc) => arc.terms).map((term) => ({
          trackId,
          term,
          status: "confirmed" as const,
        })),
      );
      await t.db
        .update(tracks)
        .set({ plan: { arcs: ARCS, notes: "Imported notes." } })
        .where(eq(tracks.id, trackId));
      models.script("probe", { text: FIRST_QUESTION });
      const started = await t.request(`/api/tracks/${trackId}/sessions`, {
        method: "POST",
        cookie,
      });
      const { id: sessionId } = (await started.json()) as { id: string };
      await until(cookie, sessionId, storedMessages(1));
      models.script("plan", planAttempt(PLAN_TEXT, actions));
      await t.request(`/api/sessions/${sessionId}/skip-to-plan`, { method: "POST", cookie });
      await until(cookie, sessionId, (s) => s.state.plan === "proposed");
      const approved = await t.request(`/api/sessions/${sessionId}/approve-plan`, {
        method: "POST",
        cookie,
      });
      expect(approved.status).toBe(200);
      const [track] = await t.db.select().from(tracks).where(eq(tracks.id, trackId));
      return track?.plan;
    };

    it("appends the approved plan's terms to the arc they belong to and leaves every other arc intact", async () => {
      const plan = await planOn([
        { type: "add-planned-term", term: "query", restsOn: ["table"] },
        { type: "add-to-arc", arc: "c. databases", terms: ["query"] },
        { type: "add-plan-notes", notes: "SQL as asking questions, for their CV." },
      ]);
      expect(plan).toEqual({
        arcs: [ARCS[0], ARCS[1], { title: "C. Databases", terms: ["table", "query"] }, ARCS[3]],
        notes:
          "Imported notes.\n\n### Noted while planning\n\nSQL as asking questions, for their CV.",
      });

      // The record's request says how to place the terms, and the call sees every arc's title.
      const record = models.used.find((u) => u.purpose === "plan")?.model.doGenerateCalls[0];
      const prompt = JSON.stringify(record?.prompt);
      expect(prompt).toContain(
        "in the existing arc it belongs to, named by that arc's exact title",
      );
      for (const arc of ARCS) expect(prompt).toContain(arc.title);
    });

    it("adds a new arc at the end only for terms no arc fits", async () => {
      const plan = await planOn([
        { type: "add-planned-term", term: "query", restsOn: ["table"] },
        { type: "add-to-arc", arc: "SQL as asking questions", terms: ["query"] },
      ]);
      expect(plan?.arcs).toEqual([...ARCS, { title: "SQL as asking questions", terms: ["query"] }]);
    });
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
    // The notes are kept on the track, with the searches they rest on.
    const stored = await t.db.select().from(researchNotes);
    expect(stored.map((r) => [r.kind, r.searches])).toEqual([["plan", ["lost update"]]]);
  });

  it("answers an out-of-order action with the state machine's reason", async () => {
    const { cookie, sessionId } = await startedSession();
    const early = await t.request(`/api/sessions/${sessionId}/approve-plan`, {
      method: "POST",
      cookie,
    });
    expect(early.status).toBe(409);
    expect(await early.json()).toEqual({ error: { code: "no-plan-to-approve" } });
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

  it("rewrites a probe message whose ambiguous word the review judges to be machinery", async () => {
    const { cookie, trackId } = await learner();
    const first =
      "Before we start, I want to see where your map of this ends. In your own words, what happens between typing an address into the browser and seeing the page appear on the screen?";
    const rewrite =
      "In your own words, what happens between typing an address and seeing the page?";
    models.script("probe", { text: first, thenGenerate: [rewrite] });
    models.script("wording-review", {
      text: JSON.stringify({ flagged: [{ word: "map", machinery: true }], jargon: [] }),
    });
    const { id } = (await (
      await t.request(`/api/tracks/${trackId}/sessions`, { method: "POST", cookie })
    ).json()) as { id: string };
    await until(cookie, id, storedMessages(1));

    const [message] = await t.db
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, id));
    expect(message?.text).toBe(rewrite);
    const asked = JSON.stringify(
      models.used.find((u) => u.purpose === "probe")?.model.doGenerateCalls[0]?.prompt,
    );
    expect(asked).toContain("reads as the tutor's own bookkeeping here");
    // The review judges against this learner: it reads what they wrote they want to learn.
    const reviewed = JSON.stringify(
      models.used.find((u) => u.purpose === "wording-review")?.model.doGenerateCalls[0]?.prompt,
    );
    expect(reviewed).toContain("What the learner wrote they want to learn: Concurrency");
  });
});

describe("creating a track", () => {
  it("doesn't ask for a language: the tutor infers it", async () => {
    await invite(t.db, "bo@example.com");
    const cookie = await t.signIn("bo@example.com");
    const created = await t.request("/api/tracks", {
      method: "POST",
      cookie,
      body: JSON.stringify({ goal: "Geometry" }),
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
    expect(log.find((e) => e.type === "error")?.data).toEqual({ error: { code: "empty-reply" } });
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
      { code: "thinking", again: false },
      { code: "noting-answers" },
      { code: "finding-where-knowledge-ends" },
      { code: "thinking", again: false },
      { code: "recording-plan" },
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
      { code: "thinking", again: false },
      { code: "recording-plan" },
      { code: "revising-plan" },
      { code: "thinking", again: false },
      { code: "recording-plan" },
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
      { code: "researching" },
      { code: "searching-web", query: "lost update" },
      { code: "searching-web", query: "read-modify-write" },
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
      { code: "thinking", again: false },
      { code: "thinking", again: true },
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
    const outlining = await startActivity(t.db, sessionId, { code: "outlining" });
    const writing = await startActivity(t.db, sessionId, {
      code: "writing-step",
      step: 1,
      of: 3,
      again: false,
    });
    await writing.update({ detail: "Adding one is three moves" });
    await outlining.done();

    expect((await snapshot(cookie, sessionId)).activities).toMatchObject([
      {
        label: { code: "writing-step", step: 1, of: 3, again: false },
        detail: "Adding one is three moves",
        state: "running",
      },
    ]);
    await writing.done();
    expect((await snapshot(cookie, sessionId)).activities).toEqual([]);
  });
});
