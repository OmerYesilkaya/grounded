import { termEvents, tracks, users } from "@grounded/db";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.js";
import { applyActions, emptyTrackShape, loadTrackContext, validateActions } from "./track-state.js";

const t = createTestHarness();

async function newTrack() {
  const [user] = await t.db
    .insert(users)
    .values({ name: "Ada", email: "ada@example.com" })
    .returning();
  if (!user) throw new Error("no user");
  const [track] = await t.db
    .insert(tracks)
    .values({ userId: user.id, title: "How software works", language: "English" })
    .returning();
  if (!track) throw new Error("no track");
  return track.id;
}

describe("applyActions", () => {
  it("adds planned terms with what they rest on, including terms added earlier in the same batch", async () => {
    const trackId = await newTrack();
    const result = await applyActions(
      t.db,
      trackId,
      [
        { type: "add-planned-term", term: "memory", restsOn: [] },
        { type: "add-planned-term", term: "race condition", restsOn: ["Memory"] },
      ],
      { source: "plan" },
    );

    expect(result).toEqual({ ok: true });
    const context = await loadTrackContext(t.db, trackId);
    expect(context.terms).toEqual([
      { term: "memory", status: "planned", restsOn: [] },
      { term: "race condition", status: "planned", restsOn: ["memory"] },
    ]);
  });

  it("lists what a term rests on in the term list's order, the same on every load", async () => {
    const trackId = await newTrack();
    await applyActions(
      t.db,
      trackId,
      [
        { type: "add-planned-term", term: "memory", restsOn: [] },
        { type: "add-planned-term", term: "worker", restsOn: [] },
        { type: "add-planned-term", term: "race condition", restsOn: ["worker", "memory"] },
      ],
      { source: "plan" },
    );

    const context = await loadTrackContext(t.db, trackId);
    expect(context.terms.at(-1)).toEqual({
      term: "race condition",
      status: "planned",
      restsOn: ["memory", "worker"],
    });
    expect(await loadTrackContext(t.db, trackId)).toEqual(context);
  });

  it("records every status change with the learner's words as evidence", async () => {
    const trackId = await newTrack();
    await applyActions(t.db, trackId, [{ type: "add-planned-term", term: "memory", restsOn: [] }], {
      source: "plan",
    });
    await applyActions(
      t.db,
      trackId,
      [
        {
          type: "set-term-status",
          term: "MEMORY",
          status: "confirmed",
          evidence: "memory still holds 5 meanwhile",
        },
      ],
      { source: "check s1" },
    );

    expect((await loadTrackContext(t.db, trackId)).terms).toEqual([
      { term: "memory", status: "confirmed", restsOn: [] },
    ]);
    const events = await t.db.select().from(termEvents);
    expect(events.map((e) => [e.fromStatus, e.toStatus, e.evidence, e.source])).toEqual([
      [null, "planned", "In the plan.", "plan"],
      ["planned", "confirmed", "memory still holds 5 meanwhile", "check s1"],
    ]);
  });

  it("adds a term the learner already knew as assumed", async () => {
    const trackId = await newTrack();
    const result = await applyActions(
      t.db,
      trackId,
      [
        {
          type: "set-term-status",
          term: "variable",
          status: "assumed",
          evidence: "a named box that holds a value",
        },
      ],
      { source: "probe" },
    );
    expect(result).toEqual({ ok: true });
    expect((await loadTrackContext(t.db, trackId)).terms).toEqual([
      { term: "variable", status: "assumed", restsOn: [] },
    ]);
  });

  it("rejects the whole batch when any edit is invalid, saying why, and changes nothing", async () => {
    const trackId = await newTrack();
    await applyActions(t.db, trackId, [{ type: "add-planned-term", term: "memory", restsOn: [] }], {
      source: "plan",
    });

    const result = await applyActions(
      t.db,
      trackId,
      [
        { type: "add-fix-item", text: "Thinks adding one is one step" },
        { type: "set-term-status", term: "lock", status: "confirmed", evidence: "takes the lock" },
        { type: "set-term-status", term: "memory", status: "taught", evidence: "  " },
        { type: "add-planned-term", term: "memory", restsOn: [] },
        { type: "add-planned-term", term: "mutex", restsOn: ["semaphore"] },
        { type: "close-fix-item", text: "Never recorded" },
      ],
      { source: "close" },
    );

    expect(result).toEqual({
      ok: false,
      errors: [
        '"lock" isn\'t in the term list; add it as a planned term first (or as assumed, if the learner already knew it).',
        'Changing "memory" needs the learner\'s words as evidence.',
        '"memory" is already in the term list.',
        '"mutex" rests on "semaphore", which isn\'t in the term list.',
        'There is no open fix-list item "Never recorded".',
      ],
    });
    const context = await loadTrackContext(t.db, trackId);
    expect(context.terms).toEqual([{ term: "memory", status: "planned", restsOn: [] }]);
    expect(context.fixList).toEqual([]);
  });

  it("keeps the fix-list and the plan", async () => {
    const trackId = await newTrack();
    await applyActions(
      t.db,
      trackId,
      [
        { type: "add-fix-item", text: "Thinks adding one is one step" },
        { type: "add-fix-item", text: "Thinks memory can add" },
        {
          type: "set-plan",
          arcs: [{ title: "Concurrency", terms: ["race condition"] }],
          notes: "",
        },
      ],
      { source: "probe" },
    );
    await applyActions(t.db, trackId, [{ type: "close-fix-item", text: "Thinks memory can add" }], {
      source: "check s1",
    });

    const context = await loadTrackContext(t.db, trackId);
    expect(context.fixList).toEqual([
      { text: "Thinks adding one is one step", status: "open" },
      { text: "Thinks memory can add", status: "closed" },
    ]);
    expect(context.plan).toEqual({
      arcs: [{ title: "Concurrency", terms: ["race condition"] }],
      notes: "",
    });
    expect(context.track).toEqual({ title: "How software works", language: "English" });
  });
});

describe("applyActions: teaching language", () => {
  it("records the language the tutor inferred", async () => {
    const trackId = await newTrack();
    expect(
      await applyActions(t.db, trackId, [{ type: "set-language", language: "Turkish" }], {
        source: "probe",
      }),
    ).toEqual({ ok: true });
    expect((await loadTrackContext(t.db, trackId)).track).toEqual({
      title: "How software works",
      language: "Turkish",
    });
  });

  it("rejects an empty language", async () => {
    const trackId = await newTrack();
    expect(
      await applyActions(t.db, trackId, [{ type: "set-language", language: "  " }], {
        source: "probe",
      }),
    ).toEqual({
      ok: false,
      errors: ["set-language needs the name of a language."],
    });
  });
});

describe("validateActions", () => {
  it("checks a batch against a track that doesn't exist yet, as it would be after each edit", () => {
    expect(
      validateActions(emptyTrackShape(), [
        { type: "set-term-status", term: "packet", status: "assumed", evidence: "probe floor" },
        { type: "add-planned-term", term: "TCP", restsOn: ["packet"] },
        { type: "set-term-status", term: "TCP", status: "confirmed", evidence: "S5 check 2" },
        { type: "set-term-status", term: "TLS", status: "taught", evidence: "S5 lesson" },
        { type: "add-planned-term", term: "QUIC", restsOn: ["UDP"] },
      ]),
    ).toEqual([
      `"TLS" isn't in the term list; add it as a planned term first (or as assumed, if the learner already knew it).`,
      `"QUIC" rests on "UDP", which isn't in the term list.`,
    ]);
  });
});
