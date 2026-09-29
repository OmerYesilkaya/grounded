import { assignments, eq, learningSessions, type Db } from "@grounded/db";
import { initialSession, type AssignmentTask } from "@grounded/core";
import { beforeEach, describe, expect, it } from "vitest";
import { invite } from "./allowlist.js";
import { createAssignment } from "./engine/assignments.js";
import { createFlows } from "./test/flows.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";

const models = scriptedModels();
const t = createTestHarness({ models: models.access });
const { learner } = createFlows(t, models);

beforeEach(() => {
  models.reset();
});

const PREDICT: AssignmentTask = {
  id: "t1",
  title: null,
  form: "predict",
  blocks: [{ id: "t1.b1", type: "paragraph", children: [{ type: "text", value: "Predict." }] }],
  source: "Predict.",
};

/** A learner with homework assigned by a closed session. */
async function assigned(tasks: AssignmentTask[] = [PREDICT]) {
  const { cookie, trackId } = await learner();
  const db: Db = t.db;
  const userId = await userOf(cookie);
  const [session] = await db
    .insert(learningSessions)
    .values({
      trackId,
      userId,
      state: { ...initialSession(), phase: "closed" },
      closedAt: new Date(),
    })
    .returning();
  const [row] = await db
    .insert(assignments)
    .values({
      trackId,
      userId,
      sessionId: session?.id ?? "",
      kind: "homework",
      title: "Two workers",
      tasks,
      checklist: [{ id: "c1", text: "Why the moves interleave" }],
      messageId: crypto.randomUUID(),
    })
    .returning();
  return { cookie, id: row?.id ?? "", trackId, userId };
}

async function userOf(cookie: string): Promise<string> {
  const me = (await (await t.request("/api/me", { cookie })).json()) as { id: string };
  return me.id;
}

const send = (cookie: string, path: string, method: string, body?: object) =>
  t.request(path, { method, cookie, ...(body ? { body: JSON.stringify(body) } : {}) });

const answer = (cookie: string, id: string, fields: Record<string, string>) =>
  send(cookie, `/api/assignments/${id}/answers`, "PUT", { taskId: "t1", fields });

const later = (cookie: string, id: string, snooze: string, timeZone = "UTC") =>
  send(cookie, `/api/assignments/${id}/later`, "POST", { snooze, timeZone });

describe("homework", () => {
  it("shows its task and what a good answer demonstrates", async () => {
    const { cookie, id } = await assigned();
    const response = await t.request(`/api/assignments/${id}`, { cookie });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: "homework",
      title: "Two workers",
      trackTitle: "Concurrency",
      // Its closed session doesn't wait for it.
      session: { number: 1, waiting: false },
      tasks: [{ id: "t1", form: "predict", blocks: [{ type: "paragraph" }] }],
      checklist: [{ id: "c1", text: "Why the moves interleave" }],
      answers: {},
      submittedAt: null,
    });
  });

  it("locks a prediction before what happened is written, and keeps it as locked", async () => {
    const { cookie, id } = await assigned();
    expect((await answer(cookie, id, { prediction: "2000", observed: "1523" })).status).toBe(409);
    expect((await answer(cookie, id, { prediction: "2000" })).status).toBe(200);
    const locked = await send(cookie, `/api/assignments/${id}/tasks/t1/lock`, "POST");
    expect(((await locked.json()) as { lockedAt: string | null }).lockedAt).toEqual(
      expect.any(String),
    );
    expect((await answer(cookie, id, { prediction: "1500" })).status).toBe(409);
    expect((await answer(cookie, id, { prediction: "2000", observed: "1523" })).status).toBe(200);
  });

  it("is handed in whole, and then can't be changed", async () => {
    const { cookie, id } = await assigned();
    await answer(cookie, id, { prediction: "2000" });
    await send(cookie, `/api/assignments/${id}/tasks/t1/lock`, "POST");
    await answer(cookie, id, { prediction: "2000", observed: "1523" });
    const early = await send(cookie, `/api/assignments/${id}/submit`, "POST");
    expect(early.status).toBe(409);
    expect(await early.json()).toEqual({ error: "Write “Reconcile” before you hand it in." });
    await answer(cookie, id, { prediction: "2000", observed: "1523", reconcile: "Interleaved." });
    expect((await send(cookie, `/api/assignments/${id}/submit`, "POST")).status).toBe(200);
    expect((await answer(cookie, id, { prediction: "2000" })).status).toBe(409);
    expect((await send(cookie, `/api/assignments/${id}/submit`, "POST")).status).toBe(409);
  });

  it("can be put off, keeping what was written, until it is handed in", async () => {
    const { cookie, id } = await assigned();
    await answer(cookie, id, { prediction: "2000" });
    expect((await later(cookie, id, "tomorrow")).status).toBe(200);
    const shown = (await (await t.request(`/api/assignments/${id}`, { cookie })).json()) as object;
    expect(shown).toMatchObject({
      answers: { t1: { fields: { prediction: "2000" } } },
      snoozedUntil: expect.any(String) as string,
    });
    await send(cookie, `/api/assignments/${id}/tasks/t1/lock`, "POST");
    await answer(cookie, id, { prediction: "2000", observed: "1523", reconcile: "Interleaved." });
    expect((await send(cookie, `/api/assignments/${id}/submit`, "POST")).status).toBe(200);
    expect((await later(cookie, id, "tomorrow")).status).toBe(409);
  });

  it("is put off till tonight or tomorrow in the learner's time zone, never without a when", async () => {
    const { cookie, id } = await assigned();
    expect((await send(cookie, `/api/assignments/${id}/later`, "POST")).status).toBe(400);
    expect((await later(cookie, id, "tomorrow", "Mars/Olympus")).status).toBe(400);
    const response = await later(cookie, id, "tomorrow", "Europe/Istanbul");
    const { snoozedUntil } = (await response.json()) as { snoozedUntil: string };
    // 9 in the morning in Istanbul (UTC+3).
    expect(new Date(snoozedUntil).getUTCHours()).toBe(6);
    expect(new Date(snoozedUntil).getTime()).toBeGreaterThan(Date.now());
  });

  it("is folded into the track's next homework, and closed then", async () => {
    const { cookie, id, trackId, userId } = await assigned();
    await answer(cookie, id, { prediction: "2000" });
    const [session] = await t.db
      .insert(learningSessions)
      .values({ trackId, userId, state: initialSession() })
      .returning();
    const next = await createAssignment(t.db, {
      session: { id: session?.id ?? "", trackId, userId },
      kind: "homework",
      message: { id: crypto.randomUUID(), text: "Explain it.", blocks: [] },
      record: { title: "Both workers", forms: ["explain"], checklist: ["Why"] },
    });
    const shown = (await (await t.request(`/api/assignments/${id}`, { cookie })).json()) as object;
    expect(shown).toMatchObject({ subsumedBy: { id: next.id, title: "Both workers" } });
    expect((await answer(cookie, id, { prediction: "2001" })).status).toBe(409);
    expect((await later(cookie, id, "tomorrow")).status).toBe(409);
    expect((await send(cookie, `/api/assignments/${id}/submit`, "POST")).status).toBe(409);
    // The next one stays open.
    const [row] = await t.db.select().from(assignments).where(eq(assignments.id, next.id));
    expect(row?.subsumedBy).toBeNull();
  });

  it("is only its learner's", async () => {
    const { id } = await assigned();
    await invite(t.db, "bea@example.com");
    const other = await t.signIn("bea@example.com");
    expect((await t.request(`/api/assignments/${id}`, { cookie: other })).status).toBe(404);
    expect((await answer(other, id, { prediction: "mine" })).status).toBe(404);
  });

  it("keeps pictures for its answers, checked by their bytes", async () => {
    const { cookie, id } = await assigned();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const upload = (bytes: Uint8Array<ArrayBuffer>, name: string) => {
      const form = new FormData();
      form.append("file", new File([bytes], name));
      return t.request(`/api/assignments/${id}/files`, { method: "POST", cookie, body: form });
    };
    expect((await upload(new TextEncoder().encode("<svg/>"), "x.png")).status).toBe(400);
    const added = await upload(png, "page.png");
    expect(added.status).toBe(201);
    const { url } = (await added.json()) as { url: string };
    const shown = await t.request(url, { cookie });
    expect(shown.headers.get("content-type")).toBe("image/png");
    expect(shown.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await shown.arrayBuffer())).toEqual(png);
  });
});
