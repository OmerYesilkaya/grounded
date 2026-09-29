import { eq, learningSessions, lessons } from "@grounded/db";
import { beforeEach, describe, expect, it } from "vitest";
import { invite } from "./allowlist.js";
import type { SessionPictures } from "./routes/progress.js";
import { createFlows } from "./test/flows.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";

const models = scriptedModels();
const t = createTestHarness({ models: models.access });
const { planned } = createFlows(t, models);

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
    await invite(t.db, "eve@example.com");
    const other = await t.signIn("eve@example.com");
    const response = await t.request(`/api/sessions/${sessionId}/pictures`, { cookie: other });
    expect(response.status).toBe(404);
  });
});
