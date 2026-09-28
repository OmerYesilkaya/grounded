import {
  createDb,
  learningSessions,
  sessionEvents,
  sessionMessages,
  tracks,
  users,
  eq,
} from "@grounded/db";
import { initialSession, type SessionState } from "@grounded/core";
import { afterAll, describe, expect, it } from "vitest";
import { invite } from "./allowlist.js";
import { appendEvent, eventsAfter, publish } from "./engine/events.js";
import { applyEvent } from "./engine/session-store.js";
import { TEST_DATABASE_URL } from "./test/global-setup.js";
import { createTestHarness } from "./test/harness.js";
import { readSse } from "./test/sse.js";

const t = createTestHarness({
  tasks: {
    // Publishes three events with pauses, like a model call streaming a reply.
    "demo-slow": async (payload) => {
      const { sessionId } = payload as { sessionId: string };
      for (const n of [1, 2, 3]) {
        await publish(t.db, sessionId, "demo", { n });
        await new Promise((r) => setTimeout(r, 150));
      }
    },
  },
});

async function signedInSession(email = "ada@example.com", state = initialSession()) {
  await invite(t.db, email);
  const cookie = await t.signIn(email);
  const [user] = await t.db.select().from(users).where(eq(users.email, email));
  if (!user) throw new Error("no user");
  const [track] = await t.db
    .insert(tracks)
    .values({ userId: user.id, title: "Concurrency", language: "English" })
    .returning();
  if (!track) throw new Error("no track");
  const [session] = await t.db
    .insert(learningSessions)
    .values({ trackId: track.id, userId: user.id, state })
    .returning();
  if (!session) throw new Error("no session");
  return { cookie, sessionId: session.id };
}

describe("session stream", () => {
  it("replays events after Last-Event-ID, then delivers new ones live", async () => {
    const { cookie, sessionId } = await signedInSession();
    const ids = [];
    for (const n of [1, 2, 3]) ids.push(await publish(t.db, sessionId, "demo", { n }));

    const controller = new AbortController();
    const response = await t.request(`/api/sessions/${sessionId}/stream`, {
      cookie,
      headers: { "last-event-id": String(ids[0]) },
      signal: controller.signal,
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = readSse(response);
    expect(await events.next(2)).toEqual([
      { id: String(ids[1]), event: "demo", data: { n: 2 } },
      { id: String(ids[2]), event: "demo", data: { n: 3 } },
    ]);
    const live = await publish(t.db, sessionId, "demo", { n: 4 });
    expect(await events.next(1)).toEqual([{ id: String(live), event: "demo", data: { n: 4 } }]);
    controller.abort();
  });

  it("keeps a job running when the browser disconnects, and catches up on reconnect", async () => {
    const { cookie, sessionId } = await signedInSession();
    await t.queue.enqueue("demo-slow", { sessionId });

    const first = new AbortController();
    const response = await t.request(`/api/sessions/${sessionId}/stream`, {
      cookie,
      signal: first.signal,
    });
    const [seen] = await readSse(response).next(1);
    first.abort();

    await t.waitFor(
      async () =>
        (await t.db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, sessionId)))
          .length === 3,
    );

    const second = new AbortController();
    const resumed = await t.request(`/api/sessions/${sessionId}/stream`, {
      cookie,
      headers: { "last-event-id": seen?.id ?? "0" },
      signal: second.signal,
    });
    expect((await readSse(resumed).next(2)).map((e) => e.data)).toEqual([{ n: 2 }, { n: 3 }]);
    second.abort();
  });

  it("snapshots a message still being written, so the stream can finish it", async () => {
    const { cookie, sessionId } = await signedInSession();
    const tutor = { role: "tutor", kind: "message" };
    // Stored earlier: in the snapshot as a stored message, not again as one being written.
    const [stored] = await t.db
      .insert(sessionMessages)
      .values({ sessionId, role: "tutor", text: "Hello.", blocks: [], kind: "message" })
      .returning();
    if (!stored) throw new Error("no message");
    await publish(t.db, sessionId, "message-start", { id: stored.id, ...tutor });
    await publish(t.db, sessionId, "message-done", { id: stored.id, ...tutor, blocks: [] });
    // Abandoned: retracted, so not shown.
    await publish(t.db, sessionId, "message-start", { id: "gone", ...tutor });
    await publish(t.db, sessionId, "message-retracted", { id: "gone" });
    // Being written as the page opens.
    await publish(t.db, sessionId, "message-start", { id: "live", ...tutor });
    await publish(t.db, sessionId, "message-delta", { id: "live", text: "In your own " });
    const cursor = await publish(t.db, sessionId, "message-delta", { id: "live", text: "words" });

    const response = await t.request(`/api/sessions/${sessionId}`, { cookie });
    const snapshot = (await response.json()) as { messages: unknown[]; lastEventId: number };
    expect(snapshot.lastEventId).toBe(cursor);
    expect(snapshot.messages).toEqual([
      { id: stored.id, ...tutor, text: null, blocks: [] },
      { id: "live", ...tutor, text: "In your own words", blocks: null, streaming: true },
    ]);
  });

  it("refuses someone else's session", async () => {
    const { sessionId } = await signedInSession("ada@example.com");
    await invite(t.db, "eve@example.com");
    const eve = await t.signIn("eve@example.com");
    expect((await t.request(`/api/sessions/${sessionId}/stream`, { cookie: eve })).status).toBe(
      404,
    );
  });
});

// A second connection, for a publisher whose transaction stays open while the test runs others.
const held = createDb(TEST_DATABASE_URL);
afterAll(held.close);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Appends an event in a transaction that stays open until `commit` is called. */
async function appendHeldOpen(sessionId: string, data: unknown) {
  const committed = Promise.withResolvers<undefined>();
  const appended = Promise.withResolvers<number>();
  const done = held.db.transaction(async (tx) => {
    appended.resolve(await appendEvent(tx, sessionId, "demo", data));
    await committed.promise;
  });
  void done.catch(appended.reject);
  const id = await appended.promise;
  return {
    id,
    commit: async () => {
      committed.resolve(undefined);
      await done;
    },
  };
}

/** Whether the promise settles within the time, without waiting for it past that. */
const settlesWithin = (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);

describe("session event order", () => {
  it("delivers an event whose transaction commits late, before the ones published after it", async () => {
    const { cookie, sessionId } = await signedInSession();
    const controller = new AbortController();
    const response = await t.request(`/api/sessions/${sessionId}/stream`, {
      cookie,
      signal: controller.signal,
    });
    const events = readSse(response);
    const opening = await publish(t.db, sessionId, "demo", { n: 0 });
    expect(await events.next(1)).toEqual([{ id: String(opening), event: "demo", data: { n: 0 } }]);
    // Keep reading while the events are published, as a browser does.
    const delivered = events.next(2, 2000);

    const first = await appendHeldOpen(sessionId, { n: 1 });
    let secondPublished = false;
    const second = publish(t.db, sessionId, "demo", { n: 2 }).finally(() => {
      secondPublished = true;
    });
    // Time for the stream to deliver the second event, were it visible before the first.
    await sleep(300);
    const secondWaited = !secondPublished;
    await first.commit();
    const secondId = await second;

    expect(await delivered).toEqual([
      { id: String(first.id), event: "demo", data: { n: 1 } },
      { id: String(secondId), event: "demo", data: { n: 2 } },
    ]);
    // The later event waited for the earlier one to commit.
    expect(secondWaited).toBe(true);
    controller.abort();
  });

  it("never gives the snapshot a cursor past an event still being committed", async () => {
    const { cookie, sessionId } = await signedInSession();
    const first = await appendHeldOpen(sessionId, { n: 1 });
    const second = publish(t.db, sessionId, "demo", { n: 2 });
    const snapshot = sleep(100)
      .then(() => t.request(`/api/sessions/${sessionId}`, { cookie }))
      .then((response) => response.json() as Promise<{ lastEventId: number }>)
      .finally(first.commit);
    const { lastEventId } = await snapshot;
    await second;

    // The stream resumes after the cursor, so the late event must be after it.
    const replayed = await eventsAfter(t.db, sessionId, lastEventId);
    expect(replayed.map((e) => e.data)).toContainEqual({ n: 1 });
  });

  it("does not make one session's events wait for another's", async () => {
    const { sessionId } = await signedInSession("ada@example.com");
    const { sessionId: otherId } = await signedInSession("grace@example.com");
    const first = await appendHeldOpen(sessionId, { n: 1 });
    const other = await settlesWithin(publish(t.db, otherId, "demo", { n: 1 }), 1000);
    await first.commit();
    expect(other).toBe(true);
  });

  it("delivers every event of many concurrent publishers, in id order", async () => {
    const { cookie, sessionId } = await signedInSession("ada@example.com");
    const { sessionId: otherId } = await signedInSession("grace@example.com");
    const controller = new AbortController();
    const response = await t.request(`/api/sessions/${sessionId}/stream`, {
      cookie,
      signal: controller.signal,
    });
    const events = readSse(response);

    const count = 200;
    const ids = await Promise.all(
      Array.from({ length: count }, (_, n) =>
        Promise.all([
          publish(t.db, sessionId, "demo", { n }),
          publish(t.db, otherId, "demo", { n }),
        ]).then(([id]) => id),
      ),
    );

    const delivered = await events.next(count);
    const deliveredIds = delivered.map((e) => Number(e.id));
    expect(deliveredIds).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(delivered.map((e) => (e.data as { n: number }).n)).size).toBe(count);
    controller.abort();
  });

  it("publishes a session's states in the order its transitions were applied, alongside other events", async () => {
    const planning: SessionState = { ...initialSession(), phase: "plan", plan: "proposed" };
    const { sessionId } = await signedInSession("ada@example.com", planning);

    // Each transition flips the plan between proposed and revising, so the order shows. Publishes
    // run alongside, taking the session's locks in the same order.
    await Promise.all(
      Array.from({ length: 40 }, (_, n) =>
        Promise.all([
          applyEvent(t.db, sessionId, { type: n % 2 ? "plan-proposed" : "learner-message" }),
          publish(t.db, sessionId, "demo", { n }),
        ]),
      ),
    );

    const states = (await eventsAfter(t.db, sessionId, 0)).filter((e) => e.type === "state");
    const [stored] = await t.db
      .select({ state: learningSessions.state })
      .from(learningSessions)
      .where(eq(learningSessions.id, sessionId));
    expect(states).toHaveLength(40);
    expect(states.at(-1)?.data).toEqual(stored?.state);
  });
});
