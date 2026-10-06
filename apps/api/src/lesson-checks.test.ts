import {
  and,
  assignments,
  eq,
  learningSessions,
  researchNotes,
  submissions,
  termEvents,
  terms,
  tracks as tracksTable,
} from "@grounded/db";
import { initialSession } from "@grounded/core";
import { APICallError } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { createFlows, homework } from "./test/flows.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";

const models = scriptedModels();
const t = createTestHarness({ models: models.access });
const { snapshot, until, planned, activities, assignedHomework, putOffHomework } = createFlows(
  t,
  models,
);

beforeEach(() => {
  models.reset();
});

// Each step builds on what the one before it introduces, so every step ends with a check: s1's and
// s2's gate the next step, s3's is the lesson's last.
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
const step = (heading: string, body: string, check: string) =>
  `## ${heading}\n\n${body}\n\n:::check\n${check}\n:::`;
const LESSON = [
  step(
    "Adding one is three moves",
    'The value is copied out, changed, and put back.\n\n:::word{term="working copy"}\nThe copy of a value that is changed before it is put back.\n:::',
    "What is in memory meanwhile?",
  ),
  step(
    "Two workers",
    'Both copy 5, and one addition vanishes.\n\n:::word{term="lost update"}\nAn addition that vanishes because another copy was put back over it.\n:::',
    "Why 6 and not 7?",
  ),
  step(
    "Why it hides",
    "It only happens when the timing is just wrong.",
    "Why can it hide for months?",
  ),
].join("\n\n");

const verdict = (v: {
  verdict: "landed" | "unproven" | "missed";
  reply: string;
  freshQuestion?: string;
  note?: string;
  alreadyHeld?: string;
}) => ({
  thenGenerate: [
    JSON.stringify({ actions: [], freshQuestion: null, note: null, alreadyHeld: null, ...v }),
  ],
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

const LEFT_OFF = "Owed: the homework on the counter. Re-check: lost update.";

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

  it("says it is outlining, then which step it is writing", async () => {
    const { sessionId } = await inLesson();
    const lessonLabels = async () =>
      (await activities(sessionId)).filter((a) =>
        ["outlining", "writing-step"].includes(a.label.code),
      );
    await t.waitFor(async () => (await lessonLabels()).every((a) => a.state === "done"));
    expect((await lessonLabels()).map((a) => a.label)).toEqual([
      { code: "outlining" },
      { code: "writing-step", step: 1, of: 3, again: false },
      { code: "writing-step", step: 2, of: 3, again: false },
      { code: "writing-step", step: 3, of: 3, again: false },
    ]);
  });
});

describe("researching the lesson", () => {
  const approve = async () => {
    const session = await planned();
    models.enableSearch();
    return session;
  };
  const written = async (session: { cookie: string; sessionId: string }) => {
    await t.request(`/api/sessions/${session.sessionId}/approve-plan`, {
      method: "POST",
      cookie: session.cookie,
    });
    await until(session.cookie, session.sessionId, (s) => s.lesson?.steps.length === 3);
  };

  it("checks what it isn't sure of on the web before outlining, keeps the notes on the track, and outlines with them", async () => {
    const session = await approve();
    models.script(
      "lesson",
      { text: LESSON, thenGenerate: [JSON.stringify(OUTLINE)] },
      {
        searches: ["lost update"],
        text: "NOTES: the term dates from database papers of the 1970s.",
      },
    );
    await written(session);

    const [writer, researcher] = models.used.filter((u) => u.purpose === "lesson");
    expect(researcher?.model.doStreamCalls[0]?.tools?.map((tool) => tool.name)).toEqual([
      "web_search",
    ]);
    // The outline has its media tools, not the search: the research is a call of its own.
    expect(writer?.model.doGenerateCalls[0]?.tools?.map((tool) => tool.name)).toEqual([
      "find_image",
      "find_audio",
    ]);
    expect(JSON.stringify(writer?.model.doGenerateCalls[0]?.prompt)).toContain(
      "NOTES: the term dates from database papers",
    );
    expect(JSON.stringify(writer?.model.doStreamCalls[0]?.prompt)).toContain(
      "NOTES: the term dates from database papers",
    );
    const stored = await t.db.select().from(researchNotes);
    expect(stored.map((r) => [r.sessionId, r.kind, r.searches])).toEqual([
      [session.sessionId, "lesson", ["lost update"]],
    ]);
    const labels = (await activities(session.sessionId)).map((a) => a.label);
    expect(labels).toContainEqual({ code: "checking-facts" });
    expect(labels).toContainEqual({ code: "searching-web", query: "lost update" });
  });

  it("keeps nothing when it searched nothing", async () => {
    const session = await approve();
    models.script(
      "lesson",
      { text: LESSON, thenGenerate: [JSON.stringify(OUTLINE)] },
      { text: "Nothing to check." },
    );
    await written(session);

    expect(await t.db.select().from(researchNotes)).toEqual([]);
    const [writer] = models.used.filter((u) => u.purpose === "lesson");
    expect(JSON.stringify(writer?.model.doGenerateCalls[0]?.prompt)).not.toContain(
      "Research notes",
    );
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
    const checking = (await activities(sessionId)).filter(
      (a) => a.label.code === "checking-answer",
    );
    expect(checking.map((a) => a.state)).toEqual(["done"]);
  });

  it("marks a word card's term taught once the learner can read its step", async () => {
    const { cookie, sessionId } = await inLesson();
    const status = async (term: string) =>
      (await t.db.select().from(terms).where(eq(terms.term, term)))[0]?.status;
    // s1 is open to read; s2, behind s1's check, is not yet.
    await t.waitFor(async () => (await status("working copy")) === "taught");
    expect(await status("lost update")).toBe("planned");
    const [event] = await t.db
      .select()
      .from(termEvents)
      .where(and(eq(termEvents.toStatus, "taught"), eq(termEvents.source, "lesson s1")));
    expect(event?.evidence).toBe(
      "Given its word card in the lesson: The copy of a value that is changed before it is put back.",
    );

    models.script("check", verdict({ verdict: "landed", reply: "That's it." }));
    await answer(cookie, sessionId, "s1", { text: "memory still holds 5" });
    await until(cookie, sessionId, (s) => s.state.currentStep === "s2");
    expect(await status("lost update")).toBe("taught");
  });

  it("records what validates of a verdict's term edits, and asks once more for the rest", async () => {
    const { cookie, sessionId } = await inLesson();
    const edits = [
      { type: "set-term-status", term: "working copy", status: "confirmed", evidence: "copied" },
      { type: "set-term-status", term: "workng copy", status: "taught", evidence: "copied" },
    ];
    models.script("check", {
      thenGenerate: [
        JSON.stringify({
          verdict: "landed",
          reply: "That's it.",
          freshQuestion: null,
          note: null,
          alreadyHeld: null,
          actions: edits,
        }),
        // Asked again with the reasons, it withdraws the misspelt one.
        JSON.stringify({ actions: [] }),
      ],
    });
    await answer(cookie, sessionId, "s1", { text: "memory still holds 5 while it's copied" });
    await until(cookie, sessionId, (s) => s.state.currentStep === "s2");

    const stored = await t.db.select().from(terms);
    expect(stored.find((row) => row.term === "working copy")?.status).toBe("confirmed");
    const calls = models.used.find((u) => u.purpose === "check")?.model.doGenerateCalls;
    expect(calls).toHaveLength(2);
    const again = JSON.stringify(calls?.[1]?.prompt);
    expect(again).toContain("workng copy");
    expect(again).toContain("isn't in the term list");
  });

  it("repairs a miss with a fresh question in one turn, and notes where the step leaked", async () => {
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
    // The note is written after the reply.
    await until(
      cookie,
      sessionId,
      (s) => tutorReplies(s, "s1").length === 1 && s.lesson?.notes.s1 !== undefined,
    );

    const s = await snapshot(cookie, sessionId);
    expect(tutorReplies(s, "s1").map((m) => [m.verdict, m.text])).toEqual([
      [
        "missed",
        "Close. Memory keeps the **old** value until the copy is put back.\n\nTwo workers each copy 10. What does memory hold while they work?",
      ],
    ]);
    expect(s.state.steps.s1).toEqual({ status: "open", misses: 1, offerGate: false });
    expect(s.lesson?.notes.s1).toBe(
      "The value in memory doesn't change until the copy is put back.",
    );
  });

  it("asks a fresh question, without a repair, when the answer showed nothing, and decides the next", async () => {
    const { cookie, sessionId } = await inLesson();
    models.script(
      "check",
      verdict({
        verdict: "unproven",
        reply: "That names the step, not what happens.",
        freshQuestion:
          "A worker copies 5 and is interrupted before putting 6 back. What does memory hold?",
      }),
      verdict({ verdict: "landed", reply: "Yes: still 5." }),
    );
    await answer(cookie, sessionId, "s1", { text: "the working copy" });
    await until(cookie, sessionId, (s) => tutorReplies(s, "s1").length === 1);

    let s = await snapshot(cookie, sessionId);
    expect(tutorReplies(s, "s1").map((m) => [m.verdict, m.text])).toEqual([
      [
        "unproven",
        "That names the step, not what happens.\n\nA worker copies 5 and is interrupted before putting 6 back. What does memory hold?",
      ],
    ]);
    expect(s.state.steps.s1).toEqual({
      status: "open",
      misses: 0,
      offerGate: false,
      pressed: true,
    });
    expect(s.lesson?.notes.s1).toBeUndefined();

    await answer(cookie, sessionId, "s1", { text: "5" });
    await until(cookie, sessionId, (s) => s.state.steps.s1?.status === "passed");
    s = await snapshot(cookie, sessionId);
    expect(s.state.currentStep).toBe("s2");
    // The second grading could only decide: the schema offered landed or missed, and the prompt said so.
    const calls = models.used
      .filter((u) => u.purpose === "check")
      .flatMap((u) => u.model.doGenerateCalls);
    expect(calls).toHaveLength(2);
    const offered = (call: (typeof calls)[number] | undefined) =>
      (
        call?.responseFormat as
          { schema?: { properties?: { verdict?: { enum?: string[] } } } } | undefined
      )?.schema?.properties?.verdict?.enum;
    expect(offered(calls[0])).toEqual(["landed", "unproven", "missed"]);
    expect(offered(calls[1])).toEqual(["landed", "missed"]);
    expect(JSON.stringify(calls[1]?.responseFormat)).not.toContain("Unproven");
    expect(JSON.stringify(calls[1]?.prompt)).toContain(
      "The learner was already asked once on this step to show the idea rather than name it",
    );
  });

  it("grades again once when the repair still asks a question besides the fresh one", async () => {
    const { cookie, sessionId } = await inLesson();
    const fresh = "Two workers each copy 10. What does memory hold while they work?";
    const graded = (reply: string) =>
      JSON.stringify({
        verdict: "missed",
        reply,
        freshQuestion: fresh,
        note: null,
        alreadyHeld: null,
        actions: [],
      });
    // One grading job, graded twice: the second time with the broken rule fed back.
    models.script("check", {
      thenGenerate: [
        graded("Close. Memory keeps the old value. So what does it hold meanwhile?"),
        graded("Close. Memory keeps the old value."),
      ],
    });
    await answer(cookie, sessionId, "s1", { text: "the new value" });
    await until(cookie, sessionId, (s) => tutorReplies(s, "s1").length === 1);

    const calls = models.used.find((u) => u.purpose === "check")?.model.doGenerateCalls;
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls?.[1]?.prompt)).toContain("The reply ends with a question");
    expect(tutorReplies(await snapshot(cookie, sessionId), "s1").map((m) => m.text)).toEqual([
      `Close. Memory keeps the old value.\n\n${fresh}`,
    ]);
  });

  it("offers pause or continue after a second miss when the next step rests on this one", async () => {
    const { cookie, sessionId } = await inLesson();
    models.script(
      "check",
      verdict({ verdict: "missed", reply: "Not yet.", freshQuestion: "Try this one?" }),
      // The model can't tell the question will be withheld; the app drops it.
      verdict({
        verdict: "missed",
        reply: "This idea is still settling; that's fine.",
        freshQuestion: "And this one?",
      }),
    );
    await answer(cookie, sessionId, "s1", { dontKnow: true });
    await until(cookie, sessionId, (s) => tutorReplies(s, "s1").length === 1);
    await answer(cookie, sessionId, "s1", { text: "still not sure" });
    await until(
      cookie,
      sessionId,
      (s) => s.state.steps.s1?.offerGate === true && tutorReplies(s, "s1").length === 2,
    );
    expect(tutorReplies(await snapshot(cookie, sessionId), "s1").map((m) => m.text)).toEqual([
      "Not yet.\n\nTry this one?",
      "This idea is still settling; that's fine.",
    ]);

    const blocked = await answer(cookie, sessionId, "s1", { text: "one more try" });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: { code: "pause-or-continue-first" } });

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
    // Resuming posts the fresh question alone.
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
    await until(cookie, sessionId, (s) => tutorReplies(s, "s1").length === 1);
    await answer(cookie, sessionId, "s1", { dontKnow: true });
    await until(
      cookie,
      sessionId,
      (s) => s.state.steps.s1?.offerGate === true && tutorReplies(s, "s1").length === 2,
    );

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

  it("grades every step on the same start of the prompt: the method's parts and the track, then the step", async () => {
    const { cookie, sessionId } = await inLesson();
    models.script(
      "check",
      verdict({ verdict: "landed", reply: "Yes." }),
      verdict({ verdict: "landed", reply: "Yes." }),
    );
    for (const id of ["s1", "s2"]) {
      await answer(cookie, sessionId, id, { text: "an answer" });
      await until(cookie, sessionId, (s) => s.state.steps[id]?.status === "passed");
    }

    const [first, second] = models.used
      .filter((u) => u.purpose === "check")
      .map((u) => u.model.doGenerateCalls[0]?.prompt.filter((m) => m.role === "system") ?? []);
    expect(first).toHaveLength(4);
    expect(second?.slice(0, 3)).toEqual(first?.slice(0, 3));
    expect(second?.[3]).not.toEqual(first?.[3]);
    expect(JSON.stringify(first?.[3])).toContain("The step being checked");
  });

  it("sends the answer being graded once, as the turn, and the step's earlier exchanges in the thread", async () => {
    const { cookie, sessionId } = await inLesson();
    models.script(
      "check",
      verdict({ verdict: "missed", reply: "Not yet.", freshQuestion: "Try this one?" }),
      verdict({ verdict: "landed", reply: "Yes." }),
    );
    await answer(cookie, sessionId, "s1", { text: "the new value" });
    await until(cookie, sessionId, (s) => tutorReplies(s, "s1").length === 1);
    await answer(cookie, sessionId, "s1", { text: "the old value, until it is put back" });
    await until(cookie, sessionId, (s) => s.state.steps.s1?.status === "passed");

    const [first, second] = models.used
      .filter((u) => u.purpose === "check")
      .map((u) => JSON.stringify(u.model.doGenerateCalls[0]?.prompt));
    const occurrences = (text: string | undefined, part: string) =>
      (text?.split(part).length ?? 1) - 1;
    expect(occurrences(first, "the new value")).toBe(1);
    expect(first).toContain("Its check thread so far");
    expect(first).toContain("(none)");
    expect(occurrences(second, "the old value, until it is put back")).toBe(1);
    expect(second).toContain("Learner: the new value");
    expect(second).toContain("Tutor: Not yet.");
    expect(second).not.toContain("Learner: the old value");
  });

  it("checks at the point of need: a step nothing rests on yet opens with the next, whose check covers both", async () => {
    const session = await planned();
    const outline = {
      title: "Why two writers lose an update",
      steps: [
        { ...OUTLINE.steps[0], restsOn: [] },
        { ...OUTLINE.steps[1], restsOn: [] },
        { ...OUTLINE.steps[2], restsOn: ["working copy", "lost update"] },
      ],
    };
    const lesson = [
      '## Adding one is three moves\n\nThe value is copied out, changed, and put back.\n\n:::word{term="working copy"}\nThe copy of a value that is changed before it is put back.\n:::',
      step(
        "Two workers",
        'Both copy 5, and one addition vanishes.\n\n:::word{term="lost update"}\nAn addition that vanishes because another copy was put back over it.\n:::',
        "Why 6?",
      ),
      step("Why it hides", "It only happens when the timing is just wrong.", "Why months?"),
    ].join("\n\n");
    models.script("lesson", { text: lesson, thenGenerate: [JSON.stringify(outline)] });
    await t.request(`/api/sessions/${session.sessionId}/approve-plan`, {
      method: "POST",
      cookie: session.cookie,
    });
    await until(session.cookie, session.sessionId, (s) => s.lesson?.steps.length === 3);

    const s = await snapshot(session.cookie, session.sessionId);
    expect(s.state.currentStep).toBe("s2");
    expect(s.state.steps.s1?.status).toBe("unchecked");
    expect(s.state.lesson.steps.map((x) => x.check !== null)).toEqual([false, true, true]);
    expect(
      (await answer(session.cookie, session.sessionId, "s1", { text: "too early" })).status,
    ).toBe(409);

    models.script("check", verdict({ verdict: "landed", reply: "Yes." }));
    await answer(session.cookie, session.sessionId, "s2", { text: "B copied an old 5" });
    await until(session.cookie, session.sessionId, (x) => x.state.currentStep === "s3");
    const grading = JSON.stringify(
      models.used.find((u) => u.purpose === "check")?.model.doGenerateCalls[0]?.prompt,
    );
    expect(grading).toContain("The steps this check covers (it ends step 2)");
    expect(grading).toContain("The copy of a value that is changed before it is put back.");
    expect(grading).toContain("This check covers: working copy, lost update.");
  });

  it("only takes an answer for the step being checked", async () => {
    const { cookie, sessionId } = await inLesson();
    const early = await answer(cookie, sessionId, "s2", { text: "jumping ahead" });
    expect(early.status).toBe(409);
    expect(await early.json()).toEqual({ error: { code: "step-not-checked" } });
  });
});

describe("closing the session", () => {
  const REWRITTEN_PLAN = {
    arcs: [
      { title: "Concurrency", terms: ["lost update"] },
      { title: "Memory", terms: ["working copy"] },
    ],
    notes: "Folded in: the counter first.",
  };

  it("assigns homework, recaps, sweeps the terms and closes", async () => {
    const { cookie, sessionId } = await inLesson();
    models.script(
      "check",
      verdict({ verdict: "landed", reply: "Yes." }),
      verdict({ verdict: "landed", reply: "Yes." }),
      verdict({ verdict: "landed", reply: "Yes." }),
    );
    models.script(
      "homework",
      homework(
        "Predict what a counter shows after two workers add one 1000 times each, then run it.",
      ),
    );
    const sweep = (actions: object[]) => ({ thenGenerate: [JSON.stringify({ actions })] });
    const confirmLostUpdate = {
      type: "set-term-status",
      term: "lost update",
      status: "confirmed",
      evidence: "one addition vanishes",
    };
    models.script("close", {
      text: "We built why a counter can lose an update: adding one is three moves, and two workers can interleave.",
    });
    models.script(
      "term-sweep",
      // The first sweep touches a term that doesn't exist and is rejected whole; the second is right.
      sweep([
        confirmLostUpdate,
        { type: "set-term-status", term: "nonsense", status: "confirmed", evidence: "x" },
      ]),
      // The close sees the whole plan and its notes, so its set-plan replaces them.
      sweep([confirmLostUpdate, { type: "set-plan", ...REWRITTEN_PLAN }]),
    );
    models.script("left-off", { text: LEFT_OFF });
    // Handed in, the homework is reviewed before the close: nothing leaked.
    const held = (item: string) => ({ item, mark: "held", note: "" });
    models.script("review", {
      thenGenerate: [
        JSON.stringify({ comments: [], checklist: [held("c1"), held("c2")], actions: [] }),
      ],
    });
    for (const id of ["s1", "s2", "s3"]) {
      await answer(cookie, sessionId, id, { text: "an answer" });
      await until(cookie, sessionId, (s) => s.state.steps[id]?.status === "passed");
    }
    // The session waits for the homework: handed in and reviewed (or put off), then the close.
    const homeworkId = await assignedHomework(cookie, sessionId);
    expect((await snapshot(cookie, sessionId)).state.phase).toBe("homework");
    const write = await t.request(`/api/assignments/${homeworkId}/answers`, {
      method: "PUT",
      cookie,
      body: JSON.stringify({ taskId: "t1", fields: { text: "Two workers interleave." } }),
    });
    expect(write.status).toBe(200);
    const handIn = await t.request(`/api/assignments/${homeworkId}/submit`, {
      method: "POST",
      cookie,
    });
    expect(handIn.status).toBe(200);
    await until(cookie, sessionId, (s) => s.state.phase === "closed");

    const s = await snapshot(cookie, sessionId);
    expect(s.messages.map((m) => m.kind).slice(-2)).toEqual(["homework", "recap"]);
    // The homework is kept as an assignment of its own, outliving the session.
    expect(s.assignments).toMatchObject([{ kind: "homework", title: "Two workers, one counter" }]);
    expect(s.assignments[0]?.submittedAt).not.toBeNull();
    const tracks = (await (await t.request("/api/tracks", { cookie })).json()) as {
      openSession: unknown;
    }[];
    expect(tracks[0]?.openSession).toBeNull();
    const stored = await t.db.select().from(terms);
    expect(stored.find((row) => row.term === "lost update")?.status).toBe("confirmed");

    // Last, "where you left off", from the whole session, the recap and homework included.
    const [track] = await t.db.select().from(tracksTable);
    expect(track?.plan).toEqual(REWRITTEN_PLAN);
    expect(track?.leftOff).toBe(LEFT_OFF);
    // The sweep settles the terms from the evidence: the conversation and the check threads.
    const sweepPrompt = JSON.stringify(
      models.used.find((u) => u.purpose === "term-sweep")?.model.doGenerateCalls[0]?.prompt,
    );
    // The homework is told the blocks its surface allows (design §6.3).
    const homeworkPrompt = JSON.stringify(
      models.used.find((u) => u.purpose === "homework")?.model.doStreamCalls[0]?.prompt,
    );
    expect(homeworkPrompt).toContain("Blocks you may use in the homework: paragraphs");
    expect(sweepPrompt).toContain("it just adds one");
    expect(sweepPrompt).toContain("Learner: an answer");
    expect(sweepPrompt).toContain("We built why a counter can lose an update");
    const leftOff = models.used.find((u) => u.purpose === "left-off")?.model.doGenerateCalls[0];
    expect(JSON.stringify(leftOff?.prompt)).toContain("Predict what a counter shows");
    expect(JSON.stringify(leftOff?.prompt)).toContain("We built why a counter can lose an update");
  });

  it("carries what the learner already held into the later checks, the homework and the close", async () => {
    const { cookie, sessionId } = await inLesson();
    const HELD = 'Knew adding one is three moves: "I know this, no need to explain."';
    models.script(
      "check",
      verdict({
        verdict: "landed",
        reply: "Noted; the next session starts above it.",
        alreadyHeld: HELD,
      }),
      verdict({ verdict: "landed", reply: "Yes." }),
      verdict({ verdict: "landed", reply: "Yes." }),
    );
    models.script("homework", homework("Explain it to a friend."));
    models.script("close", { text: "We built it." });
    models.script("term-sweep", { thenGenerate: [JSON.stringify({ actions: [] })] });
    models.script("left-off", { text: LEFT_OFF });
    await answer(cookie, sessionId, "s1", { text: "I know this, no need to explain." });
    await until(cookie, sessionId, (s) => s.state.steps.s1?.status === "passed");
    for (const id of ["s2", "s3"]) {
      await answer(cookie, sessionId, id, { text: "an answer" });
      await until(cookie, sessionId, (s) => s.state.steps[id]?.status === "passed");
    }
    await putOffHomework(cookie, sessionId);
    await until(cookie, sessionId, (s) => s.state.phase === "closed");

    const promptOf = (purpose: string) => {
      const model = models.used.find((u) => u.purpose === purpose)?.model;
      return JSON.stringify(model?.doGenerateCalls[0]?.prompt ?? model?.doStreamCalls[0]?.prompt);
    };
    const secondCheck = JSON.stringify(
      models.used.filter((u) => u.purpose === "check")[1]?.model.doGenerateCalls[0]?.prompt,
    );
    expect(secondCheck).toContain(
      "What the learner showed they already held, earlier in this lesson",
    );
    expect(secondCheck).toContain("Knew adding one is three moves");
    for (const purpose of ["homework", "close", "term-sweep", "left-off"]) {
      expect(promptOf(purpose), purpose).toContain("What happened at the lesson's checks");
      expect(promptOf(purpose), purpose).toContain(
        "Already held before the lesson taught it: Knew adding one is three moves",
      );
    }
    expect(promptOf("homework")).toContain("Learner: I know this, no need to explain.");
  });

  it("folds the homework the learner put off into the next one (method.md, Homework)", async () => {
    const { cookie, sessionId, trackId } = await inLesson();
    // An earlier session's homework, put off with an answer begun, and one handed in.
    const [current] = await t.db
      .select()
      .from(learningSessions)
      .where(eq(learningSessions.id, sessionId));
    const userId = current?.userId ?? "";
    const [earlier] = await t.db
      .insert(learningSessions)
      .values({
        trackId,
        userId,
        state: { ...initialSession(), phase: "closed" },
        closedAt: new Date(),
      })
      .returning();
    const old = (title: string, submittedAt: Date | null) => ({
      trackId,
      userId,
      sessionId: earlier?.id ?? "",
      kind: "homework" as const,
      title,
      tasks: [{ id: "t1", title: null, form: "explain" as const, blocks: [], source: "Tell it." }],
      checklist: [{ id: "c1", text: "Names the three moves" }],
      messageId: crypto.randomUUID(),
      submittedAt,
    });
    const [open, done] = await t.db
      .insert(assignments)
      .values([old("The counter, put off", null), old("Handed in already", new Date())])
      .returning();
    await t.db.insert(submissions).values({
      assignmentId: open?.id ?? "",
      answers: { t1: { fields: { text: "Copy, add" }, lockedAt: null } },
    });

    const landed = verdict({ verdict: "landed", reply: "Yes." });
    models.script("check", landed, landed, landed);
    models.script("homework", homework("Explain it to a friend."));
    for (const id of ["s1", "s2", "s3"]) {
      await answer(cookie, sessionId, id, { text: "an answer" });
      await until(cookie, sessionId, (s) => s.state.steps[id]?.status === "passed");
    }
    const next = await assignedHomework(cookie, sessionId);

    const prompt = JSON.stringify(
      models.used.find((u) => u.purpose === "homework")?.model.doStreamCalls[0]?.prompt,
    );
    expect(prompt).toContain("Homework the learner put off, still open");
    expect(prompt).toContain('\\"The counter, put off\\"');
    expect(prompt).toContain("Names the three moves");
    expect(prompt).toContain("Copy, add");
    expect(prompt).not.toContain("Handed in already");
    const rows = await t.db.select().from(assignments);
    expect(rows.find((r) => r.id === open?.id)?.subsumedBy).toBe(next);
    expect(rows.find((r) => r.id === done?.id)?.subsumedBy).toBeNull();
  });

  it("keeps what validates of a term sweep rejected every time", async () => {
    const { cookie, sessionId } = await inLesson();
    models.script(
      "check",
      ...["s1", "s2", "s3"].map(() => verdict({ verdict: "landed", reply: "Yes." })),
    );
    models.script("homework", homework("Explain it to a friend."));
    models.script("close", { text: "We built it." });
    const sweep = JSON.stringify({
      actions: [
        { type: "set-term-status", term: "lost update", status: "confirmed", evidence: "vanishes" },
        { type: "set-term-status", term: "nonsense", status: "confirmed", evidence: "x" },
      ],
    });
    models.script("term-sweep", ...[1, 2, 3].map(() => ({ thenGenerate: [sweep] })));
    models.script("left-off", { text: LEFT_OFF });
    for (const id of ["s1", "s2", "s3"]) {
      await answer(cookie, sessionId, id, { text: "an answer" });
      await until(cookie, sessionId, (s) => s.state.steps[id]?.status === "passed");
    }
    await putOffHomework(cookie, sessionId);
    await until(cookie, sessionId, (s) => s.state.phase === "closed");

    const stored = await t.db.select().from(terms);
    expect(stored.find((row) => row.term === "lost update")?.status).toBe("confirmed");
    expect(stored.map((row) => row.term)).not.toContain("nonsense");
  });

  it("leaves no summary from before the session when this one's can't be written", async () => {
    const { cookie, sessionId, trackId } = await inLesson();
    await t.db.update(tracksTable).set({ leftOff: "From an earlier session." });
    models.script(
      "check",
      ...["s1", "s2", "s3"].map(() => verdict({ verdict: "landed", reply: "Yes." })),
    );
    models.script("homework", homework("Explain it to a friend."));
    models.script("close", { text: "We built it." });
    models.script("term-sweep", { thenGenerate: [JSON.stringify({ actions: [] })] });
    // No "left-off" model: the call fails.
    for (const id of ["s1", "s2", "s3"]) {
      await answer(cookie, sessionId, id, { text: "an answer" });
      await until(cookie, sessionId, (s) => s.state.steps[id]?.status === "passed");
    }
    await putOffHomework(cookie, sessionId);
    await until(cookie, sessionId, (s) => s.state.phase === "closed");
    const [track] = await t.db.select().from(tracksTable).where(eq(tracksTable.id, trackId));
    expect(track?.leftOff).toBeNull();
  });
});

describe("a check that fails to run", () => {
  it("says so in the thread and lets the learner answer again", async () => {
    const { cookie, sessionId } = await inLesson();
    const failing = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.reject(
          new APICallError({
            message: "Invalid schema",
            url: "https://api.openai.com/v1/responses",
            requestBodyValues: {},
            statusCode: 400,
            responseBody: JSON.stringify({ error: { code: "invalid_json_schema" } }),
            isRetryable: false,
          }),
        ),
    });
    models.script("check", failing, verdict({ verdict: "landed", reply: "That's it." }));

    await answer(cookie, sessionId, "s1", { text: "memory still holds 5" });
    await until(cookie, sessionId, (s) => tutorReplies(s, "s1").length === 1);
    const [failure] = tutorReplies(await snapshot(cookie, sessionId), "s1");
    expect(failure?.verdict).toBeNull();
    expect(failure?.text).toContain("That didn't go through.");

    expect((await answer(cookie, sessionId, "s1", { text: "memory still holds 5" })).status).toBe(
      202,
    );
    await until(cookie, sessionId, (s) => s.state.currentStep === "s2");
  });
});
