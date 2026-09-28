import { eq, tracks } from "@grounded/db";
import { beforeEach, describe, expect, it } from "vitest";
import { invite } from "./allowlist.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";
import { FIRST_QUESTION } from "./test/flows.js";

const models = scriptedModels();
const t = createTestHarness({ models: models.access });

beforeEach(() => {
  models.reset();
});

const GOAL =
  "I want to learn how to pass backend and fullstack interviews.\n\nI've built APIs for a few years but never studied the theory.";

interface TrackRow {
  id: string;
  title: string;
  naming: boolean;
}

const signedIn = async () => {
  await invite(t.db, "ada@example.com");
  return t.signIn("ada@example.com");
};

const create = async (cookie: string, goal: string) => {
  const response = await t.request("/api/tracks", {
    method: "POST",
    cookie,
    body: JSON.stringify({ goal }),
  });
  return { status: response.status, body: (await response.json()) as TrackRow };
};

const listed = async (cookie: string, id: string) => {
  const list = (await (await t.request("/api/tracks", { cookie })).json()) as TrackRow[];
  return list.find((row) => row.id === id);
};

describe("creating a track", () => {
  it("takes short words as the name, with nothing to name", async () => {
    const cookie = await signedIn();
    const { status, body } = await create(cookie, "  How software works ");
    expect(status).toBe(201);
    expect(body).toMatchObject({ title: "How software works", naming: false });
    const [row] = await t.db.select().from(tracks).where(eq(tracks.id, body.id));
    expect(row?.goal).toBe("How software works");
  });

  it("has the tutor name a track whose words run long, the first line standing in", async () => {
    const cookie = await signedIn();
    models.script("track-name", { text: JSON.stringify({ name: '"Backend interviews."' }) });
    const { body } = await create(cookie, GOAL);
    expect(body).toMatchObject({
      title: "I want to learn how to pass backend and fullstack…",
      naming: true,
    });

    await t.waitFor(async () => (await listed(cookie, body.id))?.naming === false);
    expect(await listed(cookie, body.id)).toMatchObject({ title: "Backend interviews" });
    const call = models.used.find((u) => u.purpose === "track-name")?.model.doGenerateCalls[0];
    expect(JSON.stringify(call?.prompt)).toContain("never studied the theory");
  });

  it("keeps the stand-in when naming fails, and stops naming", async () => {
    const cookie = await signedIn();
    // No scripted model for "track-name": the call fails.
    const { body } = await create(cookie, GOAL);
    await t.waitFor(async () => (await listed(cookie, body.id))?.naming === false);
    expect(await listed(cookie, body.id)).toMatchObject({
      title: "I want to learn how to pass backend and fullstack…",
    });
  });

  it("refuses empty words, and words past the limit", async () => {
    const cookie = await signedIn();
    expect((await create(cookie, "   ")).status).toBe(400);
    expect((await create(cookie, "x".repeat(4001))).status).toBe(400);
  });

  it("opens the first session with the learner's words as typed", async () => {
    const cookie = await signedIn();
    models.script("track-name", { text: JSON.stringify({ name: "Backend interviews" }) });
    const { body } = await create(cookie, GOAL);
    models.script("probe", { text: FIRST_QUESTION });
    await t.request(`/api/tracks/${body.id}/sessions`, { method: "POST", cookie });
    await t.waitFor(() => Promise.resolve(models.used.some((u) => u.purpose === "probe")));
    const probe = models.used.find((u) => u.purpose === "probe")?.model;
    await t.waitFor(() => Promise.resolve((probe?.doStreamCalls.length ?? 0) > 0));
    const opening = probe?.doStreamCalls[0]?.prompt.find((m) => m.role === "user");
    expect(JSON.stringify(opening?.content)).toContain("never studied the theory");
  });
});
