import { beforeEach, describe, expect, it } from "vitest";
import { applyActions } from "./engine/track-state.js";
import { createFlows } from "./test/flows.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";
import type { TrackProgress } from "./track-progress.js";

const models = scriptedModels();
const t = createTestHarness({ models: models.access });
const { planned } = createFlows(t, models);

beforeEach(() => {
  models.reset();
});

const progressOf = async (cookie: string, trackId: string) =>
  (await (await t.request(`/api/tracks/${trackId}/progress`, { cookie })).json()) as TrackProgress;

describe("a track's page (#45)", () => {
  it("says what the learner owns and what is settling, with the words that showed it", async () => {
    const { cookie, trackId, sessionId } = await planned();
    await applyActions(
      t.db,
      trackId,
      [
        {
          type: "set-term-status",
          term: "working copy",
          status: "confirmed",
          evidence: "Said it.",
        },
        { type: "set-term-status", term: "lost update", status: "taught", evidence: "Half." },
        { type: "set-term-status", term: "number", status: "assumed", evidence: "Knew it." },
      ],
      { source: "check s1" },
    );

    const progress = await progressOf(cookie, trackId);
    expect(progress.owned.map((i) => [i.term, i.brought, i.evidence])).toEqual([
      ["working copy", false, "Said it."],
      ["number", true, "Knew it."],
    ]);
    expect(progress.settling).toMatchObject([
      {
        term: "lost update",
        restsOn: ["working copy"],
        evidence: "Half.",
        session: { id: sessionId, number: 1 },
      },
    ]);
    expect(progress.coming).toBe(0);
    expect(progress.revisit).toEqual(["Thinks adding one is a single step"]);
    expect(progress.arcs).toMatchObject([
      { title: "Concurrency", counts: { owned: 1, settling: 1, coming: 0 } },
    ]);
    expect(progress.arcs[0]?.map.edges).toEqual([{ term: "lost update", restsOn: "working copy" }]);
  });

  it("names no idea still to come, and is the owner's only", async () => {
    const { cookie, trackId } = await planned();
    const progress = await progressOf(cookie, trackId);
    expect(progress.owned).toEqual([]);
    expect(progress.settling).toEqual([]);
    expect(progress.coming).toBe(2);
    expect(progress.arcs[0]).toMatchObject({ current: true, counts: { coming: 2 } });

    const other = await t.signIn("eve@example.com");
    expect((await t.request(`/api/tracks/${trackId}/progress`, { cookie: other })).status).toBe(
      404,
    );
  });
});
