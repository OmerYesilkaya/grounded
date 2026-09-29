import {
  assignments,
  eq,
  learningSessions,
  reviews,
  termEvents,
  terms,
  type Db,
} from "@grounded/db";
import { initialSession, type SessionState } from "@grounded/core";
import { beforeEach, describe, expect, it } from "vitest";
import { recoverReviews } from "./engine/review-recovery.js";
import { openLeaks, openLeaksRecord } from "./engine/reviews.js";
import type { ReviewView } from "./engine/reviews.js";
import { createFlows } from "./test/flows.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";

const models = scriptedModels();
const t = createTestHarness({ models: models.access });
const { learner, until } = createFlows(t, models);

beforeEach(() => {
  models.reset();
});

const ANSWER = "Adding one is one step, so both workers add one and the counter shows both.";

const REVIEW = {
  comments: [
    {
      task: "t1",
      field: "text",
      quote: "one step",
      items: ["c1"],
      comment: "What does the machine do between reading the number and writing it back?",
    },
  ],
  checklist: [
    { item: "c1", mark: "leaked", note: "Look at your first sentence again." },
    { item: "c2", mark: "held", note: "" },
  ],
  actions: [
    {
      type: "set-term-status",
      term: "lost update",
      status: "taught",
      evidence: "the counter shows both",
    },
  ],
};

/** A learner with homework written, set by a session in this state; not handed in yet. */
async function written(state: SessionState) {
  const { cookie, trackId } = await learner();
  const db: Db = t.db;
  const me = (await (await t.request("/api/me", { cookie })).json()) as { id: string };
  await db.insert(terms).values({ trackId, term: "lost update", status: "confirmed" });
  const closed = state.phase === "closed" ? { closedAt: new Date() } : {};
  const [session] = await db
    .insert(learningSessions)
    .values({ trackId, userId: me.id, state, ...closed })
    .returning();
  const [row] = await db
    .insert(assignments)
    .values({
      trackId,
      userId: me.id,
      sessionId: session?.id ?? "",
      kind: "homework",
      title: "Two workers",
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
    cookie,
    body: JSON.stringify({ taskId: "t1", fields: { text: ANSWER } }),
  });
  return { cookie, id, trackId, sessionId: session?.id ?? "" };
}

const post = (cookie: string, path: string, body?: object) =>
  t.request(path, { method: "POST", cookie, ...(body ? { body: JSON.stringify(body) } : {}) });

const reviewOf = async (cookie: string, id: string) =>
  (
    (await (await t.request(`/api/assignments/${id}`, { cookie })).json()) as {
      review: ReviewView | null;
    }
  ).review;

const reviewed = (cookie: string, id: string, status: ReviewView["status"] = "done") =>
  t.waitFor(async () => (await reviewOf(cookie, id))?.status === status);

describe("the review of handed-in homework", () => {
  it("starts on hand-in, and the session that waits for it closes after it, hearing it", async () => {
    const { cookie, id, sessionId } = await written({
      ...initialSession(),
      phase: "homework",
      homework: "assigned",
    });
    models.script("review", { thenGenerate: [JSON.stringify(REVIEW)] });
    models.script("close", { text: "We built why a counter loses updates." });
    models.script("term-sweep", { thenGenerate: [JSON.stringify({ actions: [] })] });
    models.script("left-off", { text: "Left off at lost updates." });
    expect((await post(cookie, `/api/assignments/${id}/submit`)).status).toBe(200);
    await until(cookie, sessionId, (s) => s.state.phase === "closed");

    const review = await reviewOf(cookie, id);
    expect(review).toMatchObject({
      status: "done",
      checklist: [
        { id: "c1", mark: "leaked", note: "Look at your first sentence again." },
        { id: "c2", mark: "held", note: "" },
      ],
      comments: [
        {
          anchor: {
            taskId: "t1",
            field: "text",
            quote: "one step",
            prefix: "Adding one is ",
            suffix: ", so both workers add one and the counter shows both.",
          },
          items: ["c1"],
          resolvedAt: null,
          messages: [{ role: "tutor", text: REVIEW.comments[0]?.comment }],
        },
      ],
    });
    // Term changes from how the learner used the terms, as homework's evidence.
    const [term] = await t.db.select().from(terms);
    expect(term?.status).toBe("taught");
    const [event] = await t.db.select().from(termEvents);
    expect(event).toMatchObject({ source: "homework", evidence: "the counter shows both" });
    // The review read the answers; the close heard the review.
    const asked = JSON.stringify(
      models.used.find((u) => u.purpose === "review")?.model.doGenerateCalls[0]?.prompt,
    );
    expect(asked).toContain("[field: text]");
    expect(asked).toContain(ANSWER);
    const closing = JSON.stringify(
      models.used.find((u) => u.purpose === "close")?.model.doStreamCalls[0]?.prompt,
    );
    expect(closing).toContain("The review of what they handed in");
    expect(closing).toContain("leaked: Why adding one is three moves");
  });

  it("runs on its own after the session closed, and can be started again when it fails", async () => {
    const { cookie, id } = await written({ ...initialSession(), phase: "closed" });
    // No model for it: the review fails, and says so.
    expect((await post(cookie, `/api/assignments/${id}/submit`)).status).toBe(200);
    await reviewed(cookie, id, "failed");
    expect((await reviewOf(cookie, id))?.failure).toEqual(expect.any(String));

    // Again: its first answer quotes words the answer doesn't have, and is asked for once more.
    const astray = { ...REVIEW, comments: [{ ...REVIEW.comments[0], quote: "three moves" }] };
    models.script("review", { thenGenerate: [JSON.stringify(astray), JSON.stringify(REVIEW)] });
    expect((await post(cookie, `/api/assignments/${id}/review`)).status).toBe(202);
    await reviewed(cookie, id);
    expect((await reviewOf(cookie, id))?.comments[0]?.anchor.quote).toBe("one step");
    const again = JSON.stringify(
      models.used.find((u) => u.purpose === "review")?.model.doGenerateCalls[1]?.prompt,
    );
    expect(again).toContain('The quote \\"three moves\\" isn\'t in their text as they wrote it');
    expect((await post(cookie, `/api/assignments/${id}/review`)).status).toBe(409);
  });

  it("takes replies in a comment's card until the learner finds the flaw, and keeps open leaks for the next session", async () => {
    const { cookie, id, trackId } = await written({ ...initialSession(), phase: "closed" });
    models.script("review", { thenGenerate: [JSON.stringify(REVIEW)] });
    await post(cookie, `/api/assignments/${id}/submit`);
    await reviewed(cookie, id);
    const comment = (await reviewOf(cookie, id))?.comments[0];
    const path = `/api/assignments/${id}/review/comments/${comment?.id ?? ""}/replies`;
    const threadOf = async () => (await reviewOf(cookie, id))?.comments[0];

    // The leak is open: the next session's review can read it, labelled for its record.
    const record = await openLeaksRecord(t.db, trackId);
    expect(record?.text).toContain('L1: in their homework "Two workers", on «one step» in');
    expect(record?.labels.get("L1")).toBe(comment?.id);

    models.script("review-reply", { text: "And what can the other worker do meanwhile?" });
    models.script("review-record", { thenGenerate: [JSON.stringify({ resolved: false })] });
    expect((await post(cookie, path, { text: "It reads, then writes." })).status).toBe(201);
    expect((await post(cookie, path, { text: "And?" })).status).toBe(409);
    await t.waitFor(async () => (await threadOf())?.messages.length === 3);

    models.script("review-reply", { text: "That's the flaw: both read 1000." });
    models.script("review-record", { thenGenerate: [JSON.stringify({ resolved: true })] });
    await post(cookie, path, { text: "Read the same number before either writes back." });
    await t.waitFor(async () => (await threadOf())?.resolvedAt !== null);
    expect((await threadOf())?.messages.map((m) => m.role)).toEqual([
      "tutor",
      "learner",
      "tutor",
      "learner",
      "tutor",
    ]);
    // The reply's call went on from the comment and its thread.
    const replied = JSON.stringify(
      models.used.filter((u) => u.purpose === "review-reply")[1]?.model.doStreamCalls[0]?.prompt,
    );
    expect(replied).toContain(REVIEW.comments[0]?.comment);
    expect(replied).toContain("It reads, then writes.");
    expect(await openLeaks(t.db, trackId)).toEqual([]);
    expect((await post(cookie, path, { text: "More?" })).status).toBe(409);
  });

  it("is marked failed when a job that died left it under way, so it can be started again", async () => {
    const { cookie, id } = await written({ ...initialSession(), phase: "closed" });
    await t.db.update(assignments).set({ submittedAt: new Date() }).where(eq(assignments.id, id));
    await t.db
      .insert(reviews)
      .values({ assignmentId: id, updatedAt: new Date(Date.now() - 60_000) });
    await recoverReviews(t.db, 30_000);
    expect((await reviewOf(cookie, id))?.status).toBe("failed");
  });
});
