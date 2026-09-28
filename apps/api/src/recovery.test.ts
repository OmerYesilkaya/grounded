import type { SessionState } from "@grounded/core";
import {
  asc,
  checkMessages,
  eq,
  learningSessions,
  lessons,
  sessionEvents,
  sql,
  type Db,
} from "@grounded/db";
import { MockLanguageModelV4 } from "ai/test";
import { v7 as uuidv7 } from "uuid";
import { beforeEach, describe, expect, it } from "vitest";
import { publish, type ActivityEvent } from "./engine/events.js";
import { ProviderCallError } from "./engine/model-call.js";
import { recoverAbandonedWork } from "./engine/recovery.js";
import { checkFailedText } from "./engine/session-tasks.js";
import { createFlows } from "./test/flows.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";

// A job that runs until the test lets it finish: live work, holding its session's work lock.
let stalled = Promise.withResolvers<undefined>();
let released = Promise.withResolvers<undefined>();
const models = scriptedModels();
const t = createTestHarness({
  models: models.access,
  tasks: {
    stall: async () => {
      stalled.resolve(undefined);
      await released.promise;
    },
  },
});
const { snapshot, until, planned, startedSession } = createFlows(t, models);

beforeEach(() => {
  models.reset();
  stalled = Promise.withResolvers<undefined>();
  released = Promise.withResolvers<undefined>();
});

const OUTLINE = {
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
  "## Adding one is three moves\n\nThe value is copied out into a working copy, changed, and put back.\n\n:::check\nWhat is in memory meanwhile?\n:::",
  "## Two workers\n\nBoth copy 5, and one addition vanishes: a lost update.\n\n:::check\nWhy 6 and not 7?\n:::",
].join("\n\n");

async function inLesson() {
  const session = await planned();
  models.script("lesson", { text: LESSON, thenGenerate: [JSON.stringify(OUTLINE)] });
  await t.request(`/api/sessions/${session.sessionId}/approve-plan`, {
    method: "POST",
    cookie: session.cookie,
  });
  await until(session.cookie, session.sessionId, (s) => s.lesson?.steps.length === 2);
  await idle(session.sessionId);
  return session;
}

/** Waits until no job for the session is running or waiting to run. */
const idle = (sessionId: string) =>
  t.waitFor(async () => {
    const rows = await t.db.execute(sql`
      select 1 from graphile_worker._private_jobs
      where payload->>'sessionId' = ${sessionId} and (locked_at is not null or is_available)`);
    return rows.length === 0;
  });

/** A job left behind by a worker that died running it: attempted, still locked, never to run again. */
const deadJob = async (task: string, payload: Record<string, string>) => {
  const id = await queuedJob(task, payload);
  await t.db.execute(sql`
    update graphile_worker._private_jobs
    set locked_at = now(), locked_by = 'worker-that-died', attempts = 1
    where id = ${id}`);
};

/** A job waiting its turn in the queue (not due during the test). Returns its id. */
const queuedJob = async (task: string, payload: Record<string, string>) => {
  const [job] = await t.db.execute(sql`
    select id from graphile_worker.add_job(${task}, ${JSON.stringify(payload)}::json,
      run_at := now() + interval '1 hour', max_attempts := 1)`);
  return String(job?.id);
};

const events = (sessionId: string) =>
  t.db
    .select()
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, sessionId))
    .orderBy(asc(sessionEvents.id));

const eventsOf = async (sessionId: string, type: string) =>
  (await events(sessionId)).filter((e) => e.type === type).map((e) => e.data);

/** What a dead job leaves behind in the chat: a message it started, and what it was doing. */
async function abandonMessage(db: Db, sessionId: string) {
  const messageId = uuidv7();
  await publish(db, sessionId, "message-start", { id: messageId, role: "tutor", kind: "message" });
  await publish(db, sessionId, "message-delta", { id: messageId, text: "So when a progr" });
  const activity: ActivityEvent = {
    id: uuidv7(),
    label: "Thinking…",
    detail: null,
    state: "running",
  };
  await publish(db, sessionId, "activity", activity);
  return { messageId, activity };
}

describe("recovery after a worker dies mid-job", () => {
  it("retracts a message that was being written and ends what the job was doing", async () => {
    const { cookie, sessionId } = await startedSession();
    await idle(sessionId);
    const { messageId, activity } = await abandonMessage(t.db, sessionId);
    const before = await snapshot(cookie, sessionId);
    expect(before.messages).toHaveLength(2);
    expect(before.activities).toHaveLength(1);

    expect(await recoverAbandonedWork(t.db)).toEqual([
      { sessionId, messages: 1, activities: 1, checks: [], lesson: false },
    ]);

    expect(await eventsOf(sessionId, "message-retracted")).toEqual([{ id: messageId }]);
    expect(await eventsOf(sessionId, "activity")).toContainEqual({ ...activity, state: "done" });
    expect(await eventsOf(sessionId, "error")).toEqual([
      { message: "The tutor was interrupted by a problem on our side. Try again." },
    ]);
    const after = await snapshot(cookie, sessionId);
    expect(after.messages.map((m) => m.role)).toEqual(["tutor"]);
    expect(after.activities).toEqual([]);
  });

  it("changes nothing when run again", async () => {
    const { sessionId } = await startedSession();
    await idle(sessionId);
    await abandonMessage(t.db, sessionId);
    await recoverAbandonedWork(t.db);
    const count = (await events(sessionId)).length;

    expect(await recoverAbandonedWork(t.db)).toEqual([]);
    expect(await events(sessionId)).toHaveLength(count);
  });

  it("leaves a session alone while a live job is working on it", async () => {
    const { cookie, sessionId } = await startedSession();
    await idle(sessionId);
    await abandonMessage(t.db, sessionId);
    await t.queue.enqueue("stall", { sessionId });
    await stalled.promise;
    const count = (await events(sessionId)).length;

    expect(await recoverAbandonedWork(t.db)).toEqual([]);
    expect(await events(sessionId)).toHaveLength(count);
    expect((await snapshot(cookie, sessionId)).messages).toHaveLength(2);

    // Once the job is gone, what is left half-done is recovered.
    released.resolve(undefined);
    await idle(sessionId);
    expect(await recoverAbandonedWork(t.db)).toMatchObject([{ sessionId, messages: 1 }]);
  });

  it("tells a check answer whose job died that it didn't go through, and takes a new answer", async () => {
    const { cookie, sessionId } = await inLesson();
    await t.db
      .insert(checkMessages)
      .values({ sessionId, stepId: "s1", role: "learner", text: "memory still holds 5" });
    await deadJob("check", { sessionId, stepId: "s1" });

    expect(await recoverAbandonedWork(t.db)).toEqual([
      { sessionId, messages: 0, activities: 0, checks: ["s1"], lesson: false },
    ]);

    const thread = (await snapshot(cookie, sessionId)).checks;
    expect(thread.map((m) => [m.role, m.text])).toEqual([
      ["learner", "memory still holds 5"],
      ["tutor", checkFailedText()],
    ]);
    expect(await eventsOf(sessionId, "check-message")).toContainEqual(
      expect.objectContaining({ stepId: "s1", role: "tutor", verdict: null }),
    );
    expect(await eventsOf(sessionId, "error")).toHaveLength(1);

    models.script("check", {
      thenGenerate: [
        JSON.stringify({
          verdict: "landed",
          reply: "That's it.",
          actions: [],
          freshQuestion: null,
          note: null,
        }),
      ],
    });
    const again = await t.request(`/api/sessions/${sessionId}/steps/s1/answer`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ text: "memory still holds 5" }),
    });
    expect(again.status).toBe(202);
    await until(cookie, sessionId, (s) => s.state.currentStep === "s2");
  });

  it("leaves a check answer whose job is still queued to that job", async () => {
    const { cookie, sessionId } = await inLesson();
    await t.db
      .insert(checkMessages)
      .values({ sessionId, stepId: "s1", role: "learner", text: "memory still holds 5" });
    await queuedJob("check", { sessionId, stepId: "s1" });

    expect(await recoverAbandonedWork(t.db)).toEqual([]);
    expect((await snapshot(cookie, sessionId)).checks.map((m) => m.role)).toEqual(["learner"]);
  });

  it("doesn't grade an answer recovery already answered", async () => {
    const { cookie, sessionId } = await inLesson();
    await t.db
      .insert(checkMessages)
      .values({ sessionId, stepId: "s1", role: "learner", text: "memory still holds 5" });
    await recoverAbandonedWork(t.db);

    // A check job that only started after recovery: it finds nothing waiting for a verdict.
    await t.queue.enqueue("check", { sessionId, stepId: "s1" });
    await idle(sessionId);
    expect(models.used.filter((u) => u.purpose === "check")).toEqual([]);
    expect((await snapshot(cookie, sessionId)).checks.map((m) => m.role)).toEqual([
      "learner",
      "tutor",
    ]);
  });

  it("marks a lesson that stopped mid-writing failed", async () => {
    const { cookie, sessionId } = await inLesson();
    // The job died after writing the first of the outline's two steps.
    const [lesson] = await t.db.select().from(lessons).where(eq(lessons.sessionId, sessionId));
    await t.db
      .update(lessons)
      .set({ steps: lesson?.steps.slice(0, 1) ?? [] })
      .where(eq(lessons.sessionId, sessionId));
    await deadJob("lesson", { sessionId });

    expect(await recoverAbandonedWork(t.db)).toEqual([
      { sessionId, messages: 0, activities: 0, checks: [], lesson: true },
    ]);
    const s = await snapshot(cookie, sessionId);
    expect(s.state.lesson.status).toBe("failed");
    expect(s.lesson?.steps).toHaveLength(1);
    expect(await eventsOf(sessionId, "error")).toEqual([
      {
        message:
          "Writing the lesson was interrupted by a problem on our side, and it can't be finished.",
      },
    ]);
    expect(await recoverAbandonedWork(t.db)).toEqual([]);
  });

  it("marks a lesson whose job died before its outline failed, unless the job is still queued", async () => {
    const { cookie, sessionId } = await planned();
    await idle(sessionId);
    // The plan was approved and the lesson job started, then died before the outline.
    const generating: SessionState = {
      phase: "lesson",
      plan: "approved",
      lesson: { status: "generating", steps: [] },
      steps: {},
      currentStep: null,
    };
    await t.db
      .update(learningSessions)
      .set({ state: generating })
      .where(eq(learningSessions.id, sessionId));

    await queuedJob("lesson", { sessionId });
    expect(await recoverAbandonedWork(t.db)).toEqual([]);

    await t.db.execute(sql`
      delete from graphile_worker._private_jobs where payload->>'sessionId' = ${sessionId}`);
    expect(await recoverAbandonedWork(t.db)).toMatchObject([{ sessionId, lesson: true }]);
    expect((await snapshot(cookie, sessionId)).state.lesson.status).toBe("failed");
  });

  it("leaves a lesson whose job failed alone: the job marked it failed and said why", async () => {
    const { cookie, sessionId } = await planned();
    await idle(sessionId);
    const outOfCredit = new ProviderCallError("no-credit", "Your OpenAI account is out of credit.");
    models.script(
      "lesson",
      new MockLanguageModelV4({ doGenerate: () => Promise.reject(outOfCredit) }),
    );
    await t.request(`/api/sessions/${sessionId}/approve-plan`, { method: "POST", cookie });
    await t.waitFor(async () => (await eventsOf(sessionId, "error")).length > 0);
    await idle(sessionId);
    expect((await snapshot(cookie, sessionId)).state.lesson.status).toBe("failed");

    // The next worker start finds nothing to recover, so the learner isn't told a second time.
    expect(await recoverAbandonedWork(t.db)).toEqual([]);
    expect(await eventsOf(sessionId, "error")).toEqual([{ message: outOfCredit.message }]);
  });
});
