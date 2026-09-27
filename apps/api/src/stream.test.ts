import { learningSessions, sessionEvents, sessionMessages, tracks, users, eq } from "@grounded/db";
import { initialSession } from "@grounded/core";
import { describe, expect, it } from "vitest";
import { invite } from "./allowlist.js";
import { publish } from "./engine/events.js";
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

async function signedInSession(email = "ada@example.com") {
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
    .values({ trackId: track.id, userId: user.id, state: initialSession() })
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
