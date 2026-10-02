import { eq, learningSessions, lessons } from "@grounded/db";
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionPictures } from "./routes/progress.js";
import { createFlows, planAttempt } from "./test/flows.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";

const models = scriptedModels();
const t = createTestHarness({ models: models.access });
const { planned, until } = createFlows(t, models);

beforeEach(() => {
  models.reset();
});

const pictures = async (cookie: string, sessionId: string) =>
  (await (
    await t.request(`/api/sessions/${sessionId}/pictures`, { cookie })
  ).json()) as SessionPictures;

describe("the pictures of what rests on what (#47)", () => {
  it("draws the plan's terms and what they rest on, once its record is written", async () => {
    const { cookie, sessionId } = await planned();
    const { plan, built } = await pictures(cookie, sessionId);
    expect(plan?.map).toEqual({
      nodes: [
        { term: "working copy", standing: "coming", focus: true },
        { term: "lost update", standing: "coming", focus: true },
      ],
      edges: [{ term: "lost update", restsOn: "working copy" }],
    });
    // No lesson yet: nothing built.
    expect(built).toBeNull();
  });

  it("draws only this session's ground when a first plan lays out the whole route", async () => {
    const { cookie, sessionId } = await planned([
      { type: "add-planned-term", term: "working copy", restsOn: [] },
      { type: "add-planned-term", term: "lost update", restsOn: ["working copy"] },
      { type: "add-planned-term", term: "lock", restsOn: ["lost update"] },
      { type: "add-to-arc", arc: "Concurrency", terms: ["working copy", "lost update"] },
      { type: "add-to-arc", arc: "Making it safe", terms: ["lock"] },
    ]);
    const { plan } = await pictures(cookie, sessionId);
    expect(plan?.map.nodes.map((n) => n.term)).toEqual(["working copy", "lost update"]);
  });

  it("keeps the ground of the plan a revision revises, less what it moved to a later arc", async () => {
    const { cookie, sessionId } = await planned([
      { type: "add-planned-term", term: "working copy", restsOn: [] },
      { type: "add-planned-term", term: "lost update", restsOn: ["working copy"] },
      { type: "add-to-arc", arc: "Concurrency", terms: ["working copy", "lost update"] },
    ]);
    // The revision records only what it added: "lock" this session, "deadlock" later.
    models.script(
      "plan",
      planAttempt("Revised: a deeper route.", [
        { type: "add-planned-term", term: "lock", restsOn: ["lost update"] },
        { type: "add-planned-term", term: "deadlock", restsOn: ["lock"] },
        { type: "add-to-arc", arc: "Concurrency", terms: ["lock"] },
        { type: "add-to-arc", arc: "Making it safe", terms: ["deadlock"] },
      ]),
    );
    await t.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ text: "That's too small." }),
    });
    await until(
      cookie,
      sessionId,
      (s) =>
        s.state.plan === "proposed" && s.messages.filter((m) => m.kind === "plan").length === 2,
    );
    const { plan } = await pictures(cookie, sessionId);
    expect(plan?.map.nodes.filter((n) => n.focus).map((n) => n.term)).toEqual([
      "working copy",
      "lost update",
      "lock",
    ]);
  });

  it("draws what the lesson built only once its checks are done", async () => {
    const { cookie, sessionId } = await planned();
    const outline = {
      steps: [
        { heading: "A", establishes: "a", introduces: ["lost update"], restsOn: ["working copy"] },
      ],
    };
    await t.db.insert(lessons).values({ sessionId, outline });
    const [session] = await t.db
      .select()
      .from(learningSessions)
      .where(eq(learningSessions.id, sessionId));
    const at = async (phase: "lesson" | "homework") => {
      await t.db
        .update(learningSessions)
        .set({ state: { ...(session?.state ?? ({} as never)), phase } })
        .where(eq(learningSessions.id, sessionId));
      return (await pictures(cookie, sessionId)).built;
    };

    expect(await at("lesson")).toBeNull();
    expect(await at("homework")).toEqual({
      nodes: [
        { term: "working copy", standing: "coming", focus: false },
        { term: "lost update", standing: "coming", focus: true },
      ],
      edges: [{ term: "lost update", restsOn: "working copy" }],
    });
  });

  it("is the session's owner's only", async () => {
    const { sessionId } = await planned();
    const other = await t.signIn("eve@example.com");
    const response = await t.request(`/api/sessions/${sessionId}/pictures`, { cookie: other });
    expect(response.status).toBe(404);
  });
});
