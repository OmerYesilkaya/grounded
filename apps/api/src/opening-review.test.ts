import { initialSession, type SessionState } from "@grounded/core";
import {
  assignments,
  checkMessages,
  eq,
  learningSessions,
  lessons,
  reviewComments,
  reviews,
  terms,
} from "@grounded/db";
import { beforeEach, describe, expect, it } from "vitest";
import { createFlows, FIRST_QUESTION, planAttempt, storedMessages } from "./test/flows.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";

const models = scriptedModels();
const t = createTestHarness({ models: models.access });
const { learner, snapshot, until } = createFlows(t, models);

beforeEach(() => {
  models.reset();
});

const ANSWER = "Adding one is one step, so both workers add one and the counter shows both.";
const COMMENT = "What does the machine do between reading the number and writing it back?";

/** A review with one comment, on "one step", and the first item leaked. */
const REVIEW = {
  comments: [{ task: "t1", field: "text", quote: "one step", items: ["c1"], comment: COMMENT }],
  checklist: [
    { item: "c1", mark: "leaked", note: "Look at your first sentence again." },
    { item: "c2", mark: "held", note: "" },
  ],
  actions: [],
};
const HELD = {
  comments: [],
  checklist: [
    { item: "c1", mark: "held", note: "" },
    { item: "c2", mark: "held", note: "" },
  ],
  actions: [],
};

const post = (cookie: string, path: string, body?: object) =>
  t.request(path, { method: "POST", cookie, ...(body ? { body: JSON.stringify(body) } : {}) });

/** A learner whose first session is closed, in this state. */
async function afterFirstSession(state: SessionState = { ...initialSession(), phase: "closed" }) {
  const { cookie, trackId } = await learner();
  const me = (await (await t.request("/api/me", { cookie })).json()) as { id: string };
  await t.db.insert(terms).values({ trackId, term: "lost update", status: "confirmed" });
  const [session] = await t.db
    .insert(learningSessions)
    .values({ trackId, userId: me.id, state, closedAt: new Date() })
    .returning();
  return { cookie, trackId, userId: me.id, firstSession: session?.id ?? "" };
}

/** Work the first session set, answered and handed in; waits for its review unless `wait` is false. */
async function handedIn(
  first: { cookie: string; trackId: string; userId: string; firstSession: string },
  kind: "homework" | "exam",
  review: object,
  wait = true,
) {
  const [row] = await t.db
    .insert(assignments)
    .values({
      trackId: first.trackId,
      userId: first.userId,
      sessionId: first.firstSession,
      kind,
      title: kind === "exam" ? "Counters everywhere" : "Two workers",
      tasks: [{ id: "t1", title: null, form: "explain", blocks: [], source: "Explain it." }],
      checklist: [
        { id: "c1", text: "Why adding one is three moves" },
        { id: "c2", text: "How two workers' moves interleave" },
      ],
      messageId: crypto.randomUUID(),
    })
    .returning();
  const id = row?.id ?? "";
  await t.request(`/api/assignments/${id}/answers`, {
    method: "PUT",
    cookie: first.cookie,
    body: JSON.stringify({ taskId: "t1", fields: { text: ANSWER } }),
  });
  models.script("review", { thenGenerate: [JSON.stringify(review)] });
  expect((await post(first.cookie, `/api/assignments/${id}/submit`)).status).toBe(200);
  if (wait)
    await t.waitFor(async () => {
      const [r] = await t.db.select().from(reviews).where(eq(reviews.assignmentId, id));
      return r?.status === "done";
    });
  return id;
}

async function startSession(cookie: string, trackId: string) {
  const started = await post(cookie, `/api/tracks/${trackId}/sessions`);
  expect(started.status).toBe(201);
  return ((await started.json()) as { id: string }).id;
}

/** The prompt of a purpose's nth call, as text. */
const promptOf = (purpose: string, n = 0) => {
  const calls = models.used
    .filter((u) => u.purpose === purpose)
    .flatMap((u) => [...u.model.doStreamCalls, ...u.model.doGenerateCalls]);
  return JSON.stringify(calls[n]?.prompt ?? null);
};

const SUMMARY =
  "The homework's leak held once looked at: they now see the read and the write apart.";
const decision = (v: { actions?: object[]; resolved?: string[]; finished: boolean }) => ({
  thenGenerate: [JSON.stringify({ actions: [], resolved: [], ...v })],
});

describe("the review that opens a session", () => {
  it("takes up handed-in homework's open leaks in the chat, then hands over to the probe", async () => {
    const first = await afterFirstSession();
    const { cookie, trackId } = first;
    await handedIn(first, "homework", REVIEW);
    models.script("opening-review", { text: "Your homework said adding one is one step. Is it?" });
    const sessionId = await startSession(cookie, trackId);
    await until(cookie, sessionId, storedMessages(1));
    let s = await snapshot(cookie, sessionId);
    expect(s.state.phase).toBe("review");
    expect(s.messages[0]).toMatchObject({ role: "tutor", kind: "review" });
    const opening = promptOf("opening-review");
    expect(opening).toContain("What came up since the last session, for the review");
    expect(opening).toContain('### \\"Two workers\\" (homework)');
    expect(opening).toContain("- leaked: Why adding one is three moves");
    expect(opening).toContain("- L1, on «one step» in");

    // The learner finds the flaw: the leak is resolved in this session, and the review is done.
    models.script(
      "opening-review-decision",
      decision({
        actions: [
          {
            type: "set-term-status",
            term: "lost update",
            status: "taught",
            evidence: "it reads, then writes",
          },
        ],
        resolved: ["L1"],
        finished: true,
      }),
    );
    models.script("opening-review-summary", { text: SUMMARY });
    models.script("probe", { text: FIRST_QUESTION });
    await post(cookie, `/api/sessions/${sessionId}/messages`, {
      text: "It reads, adds, then writes, and the other worker can read in between.",
    });
    await until(cookie, sessionId, (x) => x.state.phase === "probe" && storedMessages(3)(x));
    s = await snapshot(cookie, sessionId);
    expect(s.messages.map((m) => `${m.role} ${m.kind}`)).toEqual([
      "tutor review",
      "learner review",
      "tutor message",
    ]);
    const [comment] = await t.db.select().from(reviewComments);
    expect(comment?.resolvedInSession).toBe(sessionId);
    const [term] = await t.db.select().from(terms);
    expect(term?.status).toBe("taught");
    const [row] = await t.db
      .select()
      .from(learningSessions)
      .where(eq(learningSessions.id, sessionId));
    expect(row?.reviewSummary).toBe(SUMMARY);

    // The probe's opening question follows the review's last answer, with what it found; the
    // answer isn't the probe's to decide on.
    expect(promptOf("probe")).toContain("What the opening review found");
    expect(promptOf("probe")).toContain(SUMMARY);
    expect(promptOf("probe")).toContain("The review is over");
    expect(models.used.some((u) => u.purpose === "probe-decision")).toBe(false);

    // And the plan hears it too.
    models.script("probe-decision", {
      thenGenerate: [JSON.stringify({ actions: [], finished: true })],
    });
    models.script("probe-summary", { text: "Holds the read and the write apart." });
    models.script("plan", planAttempt("We build on the read and the write."));
    await post(cookie, `/api/sessions/${sessionId}/messages`, { text: "It adds one." });
    await until(cookie, sessionId, (x) => x.state.plan === "proposed");
    expect(promptOf("plan")).toContain(SUMMARY);
  });

  it("takes an arc exam first, and each review once", async () => {
    const first = await afterFirstSession();
    const homeworkId = await handedIn(first, "homework", REVIEW);
    const examId = await handedIn(first, "exam", REVIEW);
    models.script("opening-review", { text: "Let's look at your arc exam first." });
    const sessionId = await startSession(first.cookie, first.trackId);
    await until(first.cookie, sessionId, storedMessages(1));
    const opening = promptOf("opening-review");
    const exam = opening.indexOf('\\"Counters everywhere\\" (arc exam)');
    expect(exam).toBeGreaterThan(-1);
    expect(opening.indexOf('\\"Two workers\\" (homework)')).toBeGreaterThan(exam);
    expect(opening.indexOf("- L1, on")).toBeGreaterThan(exam);
    expect(opening.indexOf("- L2, on")).toBeGreaterThan(opening.indexOf("(homework)"));
    const taken = await t.db.select().from(reviews);
    expect(taken.map((r) => [r.assignmentId, r.takenUpIn]).sort()).toEqual(
      [
        [homeworkId, sessionId],
        [examId, sessionId],
      ].sort(),
    );
  });

  it("opens with the probe, with no call, when what was handed in held throughout", async () => {
    const first = await afterFirstSession();
    await handedIn(first, "homework", HELD);
    models.script("probe", { text: FIRST_QUESTION });
    const sessionId = await startSession(first.cookie, first.trackId);
    await until(first.cookie, sessionId, storedMessages(1));
    const s = await snapshot(first.cookie, sessionId);
    expect(s.state.phase).toBe("probe");
    expect(models.used.map((u) => u.purpose)).not.toContain("opening-review");
    // Taken up all the same: a later session doesn't go over it.
    const [review] = await t.db.select().from(reviews);
    expect(review?.takenUpIn).toBe(sessionId);
  });

  it("re-probes the steps the last session continued past while still shaky", async () => {
    const shaky: SessionState = {
      ...initialSession(),
      phase: "closed",
      plan: "approved",
      lesson: {
        status: "ready",
        steps: [{ id: "s1", check: { steps: ["s1"], terms: ["lost update"], gates: false } }],
      },
      steps: { s1: { status: "settling", misses: 2, offerGate: false } },
    };
    const first = await afterFirstSession(shaky);
    await t.db.insert(lessons).values({
      sessionId: first.firstSession,
      outline: {
        title: "Why a counter loses updates",
        steps: [
          { heading: "Two workers", establishes: "", introduces: ["lost update"], restsOn: [] },
        ],
      },
    });
    await t.db.insert(checkMessages).values([
      { sessionId: first.firstSession, stepId: "s1", role: "learner", text: "They both add one." },
      { sessionId: first.firstSession, stepId: "s1", role: "tutor", text: "Still settling." },
    ]);
    models.script("opening-review", { text: "Last time, two workers and one counter: what if…" });
    const sessionId = await startSession(first.cookie, first.trackId);
    await until(first.cookie, sessionId, storedMessages(1));
    expect((await snapshot(first.cookie, sessionId)).state.phase).toBe("review");
    const opening = promptOf("opening-review");
    expect(opening).toContain(
      'Steps the learner continued past while still shaky, in session 1\'s lesson \\"Why a counter loses updates\\"',
    );
    expect(opening).toContain("Learner: They both add one.");
  });

  it("takes a few answers at most, then goes on to the probe", async () => {
    const first = await afterFirstSession();
    await handedIn(first, "homework", REVIEW);
    models.script("opening-review", ...Array.from({ length: 5 }, () => ({ text: "And then?" })));
    const sessionId = await startSession(first.cookie, first.trackId);
    await until(first.cookie, sessionId, storedMessages(1));
    models.script(
      "opening-review-decision",
      ...Array.from({ length: 5 }, () => decision({ finished: false })),
    );
    models.script("opening-review-summary", { text: SUMMARY });
    models.script("probe", { text: FIRST_QUESTION });
    for (let answer = 1; answer <= 5; answer++) {
      await post(first.cookie, `/api/sessions/${sessionId}/messages`, { text: "Hmm." });
      await until(first.cookie, sessionId, storedMessages(answer * 2 + 1));
    }
    const s = await snapshot(first.cookie, sessionId);
    expect(s.state.phase).toBe("probe");
    expect(s.messages.at(-1)).toMatchObject({ role: "tutor", kind: "message" });
  });
});

describe("a review still being written as the session starts", () => {
  /** Handed-in work whose review is under way, with no job on it yet. */
  async function underWay() {
    const first = await afterFirstSession();
    const [row] = await t.db
      .insert(assignments)
      .values({
        trackId: first.trackId,
        userId: first.userId,
        sessionId: first.firstSession,
        kind: "exam",
        title: "Counters everywhere",
        tasks: [{ id: "t1", title: null, form: "explain", blocks: [], source: "Explain it." }],
        checklist: [
          { id: "c1", text: "Why adding one is three moves" },
          { id: "c2", text: "How two workers' moves interleave" },
        ],
        messageId: crypto.randomUUID(),
      })
      .returning();
    const id = row?.id ?? "";
    await t.request(`/api/assignments/${id}/answers`, {
      method: "PUT",
      cookie: first.cookie,
      body: JSON.stringify({ taskId: "t1", fields: { text: ANSWER } }),
    });
    await t.db.update(assignments).set({ submittedAt: new Date() }).where(eq(assignments.id, id));
    await t.db.insert(reviews).values({ assignmentId: id });
    const sessionId = await startSession(first.cookie, first.trackId);
    return { ...first, id, sessionId };
  }

  it("is waited for, and the review opens once it is done", async () => {
    const { cookie, id, sessionId, firstSession } = await underWay();
    await t.waitFor(async () => (await snapshot(cookie, sessionId)).state.phase === "review");
    // Waiting on the exam's review, not stalled: nothing to try again.
    const waiting = await snapshot(cookie, sessionId);
    expect(waiting.messages).toEqual([]);
    expect(waiting.stalled).toBe(false);

    models.script("review", { thenGenerate: [JSON.stringify(REVIEW)] });
    models.script("opening-review", { text: "Your arc exam first." });
    await t.queue.enqueue("review", { sessionId: firstSession, assignmentId: id });
    await until(cookie, sessionId, storedMessages(1));
    expect(promptOf("opening-review")).toContain("(arc exam)");
  });

  it("goes on to the probe, with no call, when it held throughout", async () => {
    const { cookie, id, sessionId, firstSession } = await underWay();
    models.script("review", { thenGenerate: [JSON.stringify(HELD)] });
    models.script("probe", { text: FIRST_QUESTION });
    await t.queue.enqueue("review", { sessionId: firstSession, assignmentId: id });
    await until(cookie, sessionId, (s) => s.state.phase === "probe" && storedMessages(1)(s));
    const [review] = await t.db.select().from(reviews);
    expect(review?.status).toBe("done");
    expect(models.used.map((u) => u.purpose)).not.toContain("opening-review");
  });
});
