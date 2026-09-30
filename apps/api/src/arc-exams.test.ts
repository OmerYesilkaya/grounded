import { eq, tracks } from "@grounded/db";
import { beforeEach, describe, expect, it } from "vitest";
import { EXAM_ARCS, OPEN_EXAM } from "./engine/arc-exams.js";
import { applyActions } from "./engine/track-state.js";
import type { TrackSummary } from "./track-list.js";
import {
  createFlows,
  finishProbe,
  FIRST_QUESTION,
  homework,
  planAttempt,
  storedMessages,
} from "./test/flows.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";

const models = scriptedModels();
const t = createTestHarness({ models: models.access });
const { snapshot, until, learner, assignedHomework } = createFlows(t, models);

beforeEach(() => {
  models.reset();
});

// The arc "Concurrency" is under way: an earlier session taught "working copy". This session's
// lesson teaches its last term, "lost update", and so closes the arc.
const OUTLINE = {
  title: "Why two writers lose an update",
  steps: [
    {
      heading: "Two workers",
      establishes: "interleaving loses an update",
      introduces: ["lost update"],
      restsOn: ["working copy"],
    },
  ],
};
const LESSON =
  '## Two workers\n\nBoth copy 5, and one addition vanishes.\n\n:::word{term="lost update"}\nAn addition that vanishes because another copy was put back over it.\n:::\n\n:::check\nWhy 6 and not 7?\n:::';
const EXAM =
  "Two new places the same thing happens.\n\n## A shared bank balance\n\nTwo cash machines pay out from one balance of 100. Predict the balance after each pays 30.\n\n## Why a lock helps\n\nExplain, for a friend, why making the second machine wait fixes it.";
const EXAM_RECORD = {
  title: "Counters everywhere",
  forms: ["predict", "explain"],
  checklist: ["Sees the vanished payment in a new setting", "Says what the wait prevents"],
};
const LANDED = JSON.stringify({
  actions: [],
  verdict: "landed",
  reply: "Yes.",
  freshQuestion: null,
  note: null,
  alreadyHeld: null,
});

/** A track whose arc a first session began, and a second session taken up to its homework. */
async function closingSession() {
  const { cookie, trackId } = await learner();
  await applyActions(
    t.db,
    trackId,
    [
      { type: "add-planned-term", term: "working copy", restsOn: [] },
      { type: "set-term-status", term: "working copy", status: "confirmed", evidence: "Said so." },
      { type: "add-to-arc", arc: "Concurrency", terms: ["working copy"] },
    ],
    { source: "check s1" },
  );
  models.script("probe", { text: FIRST_QUESTION });
  const started = await t.request(`/api/tracks/${trackId}/sessions`, { method: "POST", cookie });
  const { id: sessionId } = (await started.json()) as { id: string };
  await until(cookie, sessionId, storedMessages(1));
  finishProbe(models);
  models.script(
    "plan",
    planAttempt("We build on the working copy.", [
      { type: "add-planned-term", term: "lost update", restsOn: ["working copy"] },
      { type: "add-to-arc", arc: "Concurrency", terms: ["lost update"] },
    ]),
  );
  await post(cookie, `/api/sessions/${sessionId}/messages`, { text: "it copies it" });
  await until(cookie, sessionId, (s) => s.state.plan === "proposed");
  models.script("lesson", { text: LESSON, thenGenerate: [JSON.stringify(OUTLINE)] });
  await post(cookie, `/api/sessions/${sessionId}/approve-plan`);
  await until(cookie, sessionId, (s) => s.lesson?.steps.length === 1);
  models.script("check", { thenGenerate: [LANDED] });
  models.script("homework", homework("Explain it to a friend."));
  models.script("exam", { text: EXAM, thenGenerate: [JSON.stringify(EXAM_RECORD)] });
  await post(cookie, `/api/sessions/${sessionId}/steps/s1/answer`, { text: "One copy is lost." });
  const homeworkId = await assignedHomework(cookie, sessionId);
  return { cookie, trackId, sessionId, homeworkId };
}

const post = (cookie: string, path: string, body?: object) =>
  t.request(path, { method: "POST", cookie, ...(body ? { body: JSON.stringify(body) } : {}) });

/** The prompt of the latest call for this purpose. */
const promptOf = (purpose: string) =>
  JSON.stringify(
    models.used.findLast((u) => u.purpose === purpose)?.model.doStreamCalls[0]?.prompt,
  );

describe("the arc exam", () => {
  it("is set by the session that closes an arc, after its homework, one task per part", async () => {
    const { cookie, trackId, sessionId } = await closingSession();
    const { assignments, messages } = await snapshot(cookie, sessionId);
    expect(assignments.map((a) => a.kind)).toEqual(["homework", "exam"]);
    expect(messages.slice(-2).map((m) => m.kind)).toEqual(["homework", "exam"]);
    const exam = assignments.find((a) => a.kind === "exam");
    const shown = (await (
      await t.request(`/api/assignments/${exam?.id ?? ""}`, { cookie })
    ).json()) as {
      tasks: { title: string | null; form: string }[];
      session: { waiting: boolean };
    };
    expect(shown.tasks).toEqual([
      expect.objectContaining({ title: "A shared bank balance", form: "predict" }),
      expect.objectContaining({ title: "Why a lock helps", form: "explain" }),
    ]);
    // The exam never holds its session.
    expect(shown.session.waiting).toBe(false);

    // Its call was given the arc it covers, with the sessions that taught it.
    const asked = promptOf("exam");
    expect(asked).toContain(EXAM_ARCS);
    expect(asked).toContain("working copy (confirmed)");
    expect(asked).toContain('Session 1 \\"Why two writers lose an update\\": lost update');

    // The plan records which session closed the arc.
    const [track] = await t.db.select().from(tracks).where(eq(tracks.id, trackId));
    expect(track?.plan.arcs).toEqual([
      { title: "Concurrency", terms: ["working copy", "lost update"], closedIn: sessionId },
    ]);

    // The track list shows it as an item of its own.
    const list = (await (await t.request("/api/tracks", { cookie })).json()) as TrackSummary[];
    expect(list[0]?.items.map((i) => i.kind)).toEqual(["session", "homework", "exam"]);
    expect(list[0]?.items[2]).toMatchObject({
      kind: "exam",
      title: "Counters everywhere",
      session: 1,
      arcs: ["Concurrency"],
      parts: 2,
      done: false,
      due: null,
    });
  });

  it("can be put off without moving its session, and is handed in only whole", async () => {
    const { cookie, sessionId } = await closingSession();
    const exam = (await snapshot(cookie, sessionId)).assignments.find((a) => a.kind === "exam");
    const id = exam?.id ?? "";
    const later = await post(cookie, `/api/assignments/${id}/later`, {
      snooze: "tomorrow",
      timeZone: "UTC",
    });
    expect(later.status).toBe(200);
    expect((await snapshot(cookie, sessionId)).state.homework).toBe("assigned");

    // One part written is not an exam taken: nothing is handed in, nothing reviewed.
    await t.request(`/api/assignments/${id}/answers`, {
      method: "PUT",
      cookie,
      body: JSON.stringify({ taskId: "t2", fields: { text: "The wait keeps one copy out." } }),
    });
    const early = await post(cookie, `/api/assignments/${id}/submit`);
    expect(early.status).toBe(409);
    expect(await early.json()).toEqual({
      error: { code: "lock-prediction-first", part: "A shared bank balance" },
    });
    expect((await snapshot(cookie, sessionId)).assignments[1]?.submittedAt).toBeNull();
  });

  it("warns once when the next session starts with it open, whose probe then takes up its re-tests", async () => {
    const { cookie, trackId, homeworkId } = await closingSession();
    models.script("close", { text: "We built it." });
    models.script("term-sweep", { thenGenerate: [JSON.stringify({ actions: [] })] });
    models.script("left-off", { text: "Owed: the arc exam." });
    await post(cookie, `/api/assignments/${homeworkId}/later`, {
      snooze: "tomorrow",
      timeZone: "UTC",
    });
    await t.waitFor(async () => {
      const list = (await (await t.request("/api/tracks", { cookie })).json()) as TrackSummary[];
      return list[0]?.openSession === null;
    });

    const warned = await post(cookie, `/api/tracks/${trackId}/sessions`);
    expect(warned.status).toBe(409);
    expect(await warned.json()).toMatchObject({
      error: { code: "exam-open", title: "Counters everywhere" },
      exam: { title: "Counters everywhere" },
    });
    models.script("probe", { text: FIRST_QUESTION });
    const started = await post(cookie, `/api/tracks/${trackId}/sessions`);
    expect(started.status).toBe(201);
    const { id } = (await started.json()) as { id: string };
    await until(cookie, id, storedMessages(1));
    const probe = promptOf("probe");
    expect(probe).toContain(OPEN_EXAM);
    expect(probe).toContain("Two cash machines pay out");
  });
});
