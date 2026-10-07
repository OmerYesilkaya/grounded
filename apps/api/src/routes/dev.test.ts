import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createEmbedded } from "../embedded.js";
import { applyActions } from "../engine/track-state.js";
import { TEST_DATABASE_URL } from "../test/database.js";
import { createFlows } from "../test/flows.js";
import { createTestHarness } from "../test/harness.js";
import { scriptedModels } from "../test/scripted-models.js";
import type { RawTerm } from "./dev.js";

const models = scriptedModels();
const t = createTestHarness({ models: models.access });
const { planned } = createFlows(t, models);

beforeEach(() => {
  models.reset();
});

const rawTerms = async (cookie: string, trackId: string) =>
  (await (await t.request(`/api/dev/tracks/${trackId}/terms`, { cookie })).json()) as {
    terms: RawTerm[];
  };

describe("the development view of a track's terms (design §10)", () => {
  it("lists every term with the method's status, what it rests on and its history", async () => {
    const { cookie, trackId } = await planned();
    await applyActions(
      t.db,
      trackId,
      [
        { type: "set-term-status", term: "working copy", status: "taught", evidence: "Read it." },
        {
          type: "set-term-status",
          term: "working copy",
          status: "confirmed",
          evidence: "Said it.",
        },
      ],
      { source: "check s1" },
    );

    const { terms } = await rawTerms(cookie, trackId);
    expect(terms.map((term) => [term.term, term.status, term.restsOn])).toEqual([
      ["working copy", "confirmed", []],
      ["lost update", "planned", ["working copy"]],
    ]);
    expect(terms[0]?.events.map((e) => [e.from, e.to, e.evidence, e.source])).toEqual([
      [null, "planned", expect.any(String), expect.any(String)],
      ["planned", "taught", "Read it.", "check s1"],
      ["taught", "confirmed", "Said it.", "check s1"],
    ]);
    expect(terms[0]?.borrowedFrom).toBeNull();
  });

  it("is the owner's only", async () => {
    const { trackId } = await planned();
    const other = await t.signIn("eve@example.com");
    expect((await t.request(`/api/dev/tracks/${trackId}/terms`, { cookie: other })).status).toBe(
      404,
    );
  });

  describe("off in production", () => {
    const production = createEmbedded({ databaseUrl: TEST_DATABASE_URL, devTools: false });
    afterAll(production.stop);

    it("has no such route", async () => {
      // Both apps sign the cookie the same way, so the harness's learner is signed in here too.
      const { cookie, trackId } = await planned();
      const response = await production.request(`/api/dev/tracks/${trackId}/terms`, { cookie });
      expect(response.status).toBe(404);
      // The gate is the route's alone: the learner's own pages answer as ever.
      const progress = await production.request(`/api/tracks/${trackId}/progress`, { cookie });
      expect(progress.status).toBe(200);
    });
  });
});
