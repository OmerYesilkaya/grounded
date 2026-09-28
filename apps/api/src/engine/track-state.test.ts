import { initialSession } from "@grounded/core";
import { eq, learningSessions, termEvents, tracks, users } from "@grounded/db";
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
    .values({
      userId: user.id,
      title: "How software works",
      goal: "How software works",
      language: "English",
    })
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
      { source: "close", rewritePlan: true },
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

describe("applyActions: from a call that may not rewrite the plan", () => {
  it("leaves out a set-plan and applies the rest of the batch", async () => {
    const trackId = await newTrack();
    const plan = { arcs: [{ title: "Concurrency", terms: ["memory"] }], notes: "Backend first." };
    await applyActions(
      t.db,
      trackId,
      [
        { type: "add-planned-term", term: "memory", restsOn: [] },
        { type: "set-plan", ...plan },
      ],
      { source: "close", rewritePlan: true },
    );
    const result = await applyActions(
      t.db,
      trackId,
      [
        { type: "set-plan", arcs: [], notes: "" },
        { type: "set-term-status", term: "memory", status: "confirmed", evidence: "holds 5" },
      ],
      { source: "probe" },
    );
    expect(result).toEqual({ ok: true });
    const context = await loadTrackContext(t.db, trackId);
    expect(context.plan).toEqual(plan);
    expect(context.terms).toEqual([{ term: "memory", status: "confirmed", restsOn: [] }]);
  });
});

describe("applyActions: add-to-arc", () => {
  const withArcs = async () => {
    const trackId = await newTrack();
    const plan = {
      arcs: [
        { title: "Basics", terms: ["bit", "memory"] },
        { title: "Concurrency", terms: ["worker"] },
      ],
      notes: "Imported notes.",
    };
    const setUp = await applyActions(
      t.db,
      trackId,
      [
        ...["bit", "memory", "worker"].map((term) => ({
          type: "add-planned-term" as const,
          term,
          restsOn: [],
        })),
        { type: "set-plan", ...plan },
      ],
      { source: "imported", rewritePlan: true },
    );
    expect(setUp).toEqual({ ok: true });
    return { trackId, plan };
  };

  it("appends to the arc with that title, whatever its case, and leaves every other arc as it was", async () => {
    const { trackId, plan } = await withArcs();
    const result = await applyActions(
      t.db,
      trackId,
      [
        { type: "add-to-arc", arc: "concurrency", terms: ["Lost Update", "lock"] },
        { type: "add-planned-term", term: "lost update", restsOn: ["worker"] },
        { type: "add-planned-term", term: "lock", restsOn: [] },
      ],
      { source: "plan" },
    );
    expect(result).toEqual({ ok: true });
    // A term placed before the edit that adds it; written in the term list's spelling.
    expect((await loadTrackContext(t.db, trackId)).plan).toEqual({
      arcs: [plan.arcs[0], { title: "Concurrency", terms: ["worker", "lost update", "lock"] }],
      notes: "Imported notes.",
    });
  });

  it("adds a new arc at the end when no arc has the title", async () => {
    const { trackId, plan } = await withArcs();
    await applyActions(
      t.db,
      trackId,
      [
        { type: "add-planned-term", term: "query", restsOn: [] },
        { type: "add-to-arc", arc: " SQL as asking questions ", terms: ["query"] },
      ],
      { source: "plan" },
    );
    expect((await loadTrackContext(t.db, trackId)).plan.arcs).toEqual([
      ...plan.arcs,
      { title: "SQL as asking questions", terms: ["query"] },
    ]);
  });

  it("creates a track's first arcs", async () => {
    const trackId = await newTrack();
    const result = await applyActions(
      t.db,
      trackId,
      [
        { type: "add-planned-term", term: "memory", restsOn: [] },
        { type: "add-planned-term", term: "lost update", restsOn: ["memory"] },
        { type: "add-to-arc", arc: "Memory", terms: ["memory"] },
        { type: "add-to-arc", arc: "Concurrency", terms: ["lost update"] },
      ],
      { source: "plan" },
    );
    expect(result).toEqual({ ok: true });
    expect((await loadTrackContext(t.db, trackId)).plan).toEqual({
      arcs: [
        { title: "Memory", terms: ["memory"] },
        { title: "Concurrency", terms: ["lost update"] },
      ],
      notes: "",
    });
  });

  it("skips a term already in an arc, so placing a revised plan's terms again changes nothing", async () => {
    const { trackId, plan } = await withArcs();
    const result = await applyActions(
      t.db,
      trackId,
      [
        { type: "add-to-arc", arc: "Concurrency", terms: ["Memory", "worker", "worker"] },
        { type: "add-to-arc", arc: "Networks", terms: ["bit"] },
      ],
      { source: "plan" },
    );
    expect(result).toEqual({ ok: true });
    // No empty arc for terms that were all placed already.
    expect((await loadTrackContext(t.db, trackId)).plan).toEqual(plan);
  });

  it("rejects terms that aren't in the term list, and an arc with no terms", async () => {
    const { trackId, plan } = await withArcs();
    const result = await applyActions(
      t.db,
      trackId,
      [
        { type: "add-planned-term", term: "lock", restsOn: [] },
        { type: "add-to-arc", arc: "Concurrency", terms: ["lock", "semaphore"] },
        { type: "add-to-arc", arc: "Networks", terms: [] },
      ],
      { source: "plan" },
    );
    expect(result).toEqual({
      ok: false,
      errors: [
        'add-to-arc "Networks" names no terms.',
        '"semaphore" isn\'t in the term list; add it as a planned term to place it in "Concurrency".',
      ],
    });
    expect((await loadTrackContext(t.db, trackId)).plan).toEqual(plan);
  });

  it("applies after a set-plan in the same batch, to the plan the set-plan left", async () => {
    const { trackId } = await withArcs();
    await applyActions(
      t.db,
      trackId,
      [
        { type: "set-plan", arcs: [{ title: "Basics", terms: ["bit"] }], notes: "Rewritten." },
        { type: "add-to-arc", arc: "basics", terms: ["memory"] },
      ],
      { source: "close", rewritePlan: true },
    );
    expect((await loadTrackContext(t.db, trackId)).plan).toEqual({
      arcs: [{ title: "Basics", terms: ["bit", "memory"] }],
      notes: "Rewritten.",
    });
  });
});

describe("applyActions: from the plan's record, which saw where you left off, not the notes", () => {
  it("adds its notes after the notes as written, under one heading, and keeps the arcs", async () => {
    const trackId = await newTrack();
    const arcs = [{ title: "Concurrency", terms: [] }];
    await applyActions(t.db, trackId, [{ type: "set-plan", arcs, notes: "Imported notes." }], {
      source: "import",
      rewritePlan: true,
    });
    await applyActions(t.db, trackId, [{ type: "add-plan-notes", notes: "Backend first." }], {
      source: "plan",
    });
    // A revised plan's notes go under the same heading.
    await applyActions(
      t.db,
      trackId,
      [
        { type: "add-plan-notes", notes: "  " },
        { type: "add-plan-notes", notes: "Then the database." },
      ],
      { source: "plan" },
    );
    expect((await loadTrackContext(t.db, trackId)).plan).toEqual({
      arcs,
      notes: "Imported notes.\n\n### Noted while planning\n\nBackend first.\n\nThen the database.",
    });
  });

  it("starts a track's notes with them", async () => {
    const trackId = await newTrack();
    await applyActions(t.db, trackId, [{ type: "add-plan-notes", notes: " Backend first. " }], {
      source: "plan",
    });
    expect((await loadTrackContext(t.db, trackId)).plan).toEqual({
      arcs: [],
      notes: "Backend first.",
    });
  });
});

describe("loadTrackContext: the plan's notes", () => {
  it("carries where you left off in place of the notes, except for the close", async () => {
    const trackId = await newTrack();
    await t.db
      .update(tracks)
      .set({ plan: { arcs: [], notes: "Verbatim." }, leftOff: "Owed: homework 3." })
      .where(eq(tracks.id, trackId));
    const [track] = await t.db.select().from(tracks).where(eq(tracks.id, trackId));
    const [session] = await t.db
      .insert(learningSessions)
      .values({ trackId, userId: track?.userId ?? "", state: initialSession() })
      .returning();
    const sessionId = session?.id ?? "";
    for (const phase of ["probe", "plan", "lesson", "check", "homework"] as const) {
      expect((await loadTrackContext(t.db, trackId, { sessionId, phase })).plan, phase).toEqual({
        arcs: [],
        leftOff: "Owed: homework 3.",
      });
    }
    expect((await loadTrackContext(t.db, trackId, { sessionId, phase: "close" })).plan).toEqual({
      arcs: [],
      notes: "Verbatim.",
    });
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

describe("loadTrackContext: in a session", () => {
  const openSession = async (trackId: string) => {
    const [track] = await t.db.select().from(tracks).where(eq(tracks.id, trackId));
    if (!track) throw new Error("no track");
    const [session] = await t.db
      .insert(learningSessions)
      .values({ trackId, userId: track.userId, state: initialSession() })
      .returning();
    if (!session) throw new Error("no session");
    return session.id;
  };

  it("keeps the term list and fix-list as the session began, and gives what changed since apart", async () => {
    const trackId = await newTrack();
    await applyActions(
      t.db,
      trackId,
      [
        { type: "add-planned-term", term: "memory", restsOn: [] },
        { type: "add-planned-term", term: "worker", restsOn: [] },
        { type: "add-fix-item", text: "Thinks adding one is one step" },
        { type: "add-fix-item", text: "Thinks memory can add" },
        {
          type: "set-plan",
          arcs: [{ title: "Concurrency", terms: ["memory", "worker"] }],
          notes: "",
        },
      ],
      { source: "close", rewritePlan: true },
    );
    const sessionId = await openSession(trackId);
    const before = await loadTrackContext(t.db, trackId, { sessionId });
    expect(before.terms).toEqual([
      { term: "memory", status: "planned", restsOn: [] },
      { term: "worker", status: "planned", restsOn: [] },
    ]);
    expect(before.fixList).toEqual([
      { text: "Thinks adding one is one step", status: "open" },
      { text: "Thinks memory can add", status: "open" },
    ]);
    expect(before.changes).toEqual({ terms: [], fixList: [] });

    await applyActions(
      t.db,
      trackId,
      [
        { type: "set-term-status", term: "memory", status: "confirmed", evidence: "holds 5" },
        { type: "add-planned-term", term: "race condition", restsOn: ["memory", "worker"] },
        { type: "close-fix-item", text: "Thinks memory can add" },
        { type: "add-fix-item", text: "Thinks a lock is free" },
      ],
      { source: "probe" },
    );
    const after = await loadTrackContext(t.db, trackId, { sessionId });
    expect(after.terms).toEqual(before.terms);
    expect(after.fixList).toEqual(before.fixList);
    expect(after.changes).toEqual({
      terms: [
        { term: "memory", status: "confirmed", restsOn: [] },
        { term: "race condition", status: "planned", restsOn: ["memory", "worker"] },
      ],
      fixList: [
        { text: "Thinks memory can add", status: "closed" },
        { text: "Thinks a lock is free", status: "open" },
      ],
    });
    // The tutor's writing is validated against the track as it is now.
    expect(after.current).toEqual([
      { term: "memory", status: "confirmed" },
      { term: "worker", status: "planned" },
      { term: "race condition", status: "planned" },
    ]);
  });

  it("lists the current arc and the terms the last three sessions touched, with what they rest on", async () => {
    const trackId = await newTrack();
    const names = ["bit", "memory", "register", "packet", "TCP", "lock", "working copy"];
    const imported = await applyActions(
      t.db,
      trackId,
      [
        ...names.flatMap((term) => [
          { type: "add-planned-term" as const, term, restsOn: [] },
          {
            type: "set-term-status" as const,
            term,
            status: "confirmed" as const,
            evidence: "From the ledger.",
          },
        ]),
        { type: "add-planned-term", term: "lost update", restsOn: ["working copy"] },
        {
          type: "set-plan",
          arcs: [
            { title: "Basics", terms: names },
            { title: "Concurrency", terms: ["lost update"] },
          ],
          notes: "",
        },
      ],
      { source: "imported", rewritePlan: true },
    );
    expect(imported).toEqual({ ok: true });
    // Four earlier sessions, each touching one term; only the last three count as recent.
    for (const term of ["bit", "memory", "packet", "lock"]) {
      await openSession(trackId);
      const touched = await applyActions(
        t.db,
        trackId,
        [{ type: "set-term-status", term, status: "taught", evidence: "shaky" }],
        { source: "close" },
      );
      expect(touched).toEqual({ ok: true });
      await t.db.update(learningSessions).set({ closedAt: new Date() });
    }
    const sessionId = await openSession(trackId);

    const context = await loadTrackContext(t.db, trackId, { sessionId, phase: "probe" });
    expect(context.terms.map((t) => t.term)).toEqual([
      "memory",
      "packet",
      "lock",
      "working copy",
      "lost update",
    ]);
    expect(context.termsNotListed).toEqual({ taught: 1, confirmed: 2 });
    expect(context.plan.arcs).toEqual([
      { title: "Basics", terms: names, tally: { taught: 4, confirmed: 3 } },
      { title: "Concurrency", terms: ["lost update"], current: true },
    ]);
    // The plan's calls see every arc's terms: they place new terms in the arcs they belong to.
    const planning = await loadTrackContext(t.db, trackId, { sessionId, phase: "plan" });
    expect(planning.plan.arcs[0]).toEqual({ title: "Basics", terms: names });
  });

  it("outside a session, gives the track as it is now", async () => {
    const trackId = await newTrack();
    await applyActions(t.db, trackId, [{ type: "add-planned-term", term: "memory", restsOn: [] }], {
      source: "plan",
    });
    const context = await loadTrackContext(t.db, trackId);
    expect(context.changes).toBeUndefined();
    expect(context.terms).toEqual([{ term: "memory", status: "planned", restsOn: [] }]);
  });
});
