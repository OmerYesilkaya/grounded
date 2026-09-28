import { initialSession } from "@grounded/core";
import { eq, learningSessions, termEvents, tracks, users } from "@grounded/db";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.js";
import {
  applyActions,
  applyValidActions,
  editNotesSection,
  emptyTrackShape,
  loadTrackContext,
  validateActions,
} from "./track-state.js";

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
        '"mutex" rests on "semaphore", which isn\'t in the term list.',
        'There is no open fix-list item "Never recorded".',
      ],
    });
    const context = await loadTrackContext(t.db, trackId);
    expect(context.terms).toEqual([{ term: "memory", status: "planned", restsOn: [] }]);
    expect(context.fixList).toEqual([]);
  });

  it("keeps a planned term already in the list as it is, adding only what it rests on", async () => {
    const trackId = await newTrack();
    await applyActions(
      t.db,
      trackId,
      [
        { type: "add-planned-term", term: "memory", restsOn: [] },
        { type: "add-planned-term", term: "worker", restsOn: [] },
        { type: "add-planned-term", term: "race condition", restsOn: ["memory"] },
        { type: "set-term-status", term: "race condition", status: "taught", evidence: "both 5" },
      ],
      { source: "plan" },
    );

    // A plan that didn't see "race condition" in its prompt plans it again, resting on more.
    const result = await applyActions(
      t.db,
      trackId,
      [
        { type: "add-planned-term", term: "Race condition", restsOn: ["worker", "memory"] },
        { type: "add-planned-term", term: "lock", restsOn: ["race condition"] },
      ],
      { source: "plan" },
    );

    expect(result).toEqual({ ok: true });
    const context = await loadTrackContext(t.db, trackId);
    expect(context.terms).toEqual([
      { term: "memory", status: "planned", restsOn: [] },
      { term: "worker", status: "planned", restsOn: [] },
      { term: "race condition", status: "taught", restsOn: ["memory", "worker"] },
      { term: "lock", status: "planned", restsOn: ["race condition"] },
    ]);
    const events = await t.db.select().from(termEvents);
    expect(events).toHaveLength(5);
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
      // In the batch's order.
      errors: [
        '"semaphore" isn\'t in the term list; add it as a planned term to place it in "Concurrency".',
        'add-to-arc "Networks" names no terms.',
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

describe("editNotesSection", () => {
  const NOTES = [
    "# Plan notes",
    "",
    "Intro line.",
    "",
    "## Open threads",
    "",
    "- homework 3",
    "",
    "### Detail",
    "",
    "Under open threads.",
    "",
    "## Pacing",
    "",
    "```",
    "## not a heading",
    "```",
    "",
    "Slow down on proofs.",
  ].join("\n");

  it("replaces a section's body, subsections included, and keeps its heading as written", () => {
    expect(editNotesSection(NOTES, { heading: "##  open THREADS", text: "- none\n" })).toEqual({
      notes: [
        "# Plan notes",
        "",
        "Intro line.",
        "",
        "## Open threads",
        "",
        "- none",
        "",
        "## Pacing",
        "",
        "```",
        "## not a heading",
        "```",
        "",
        "Slow down on proofs.",
      ].join("\n"),
    });
  });

  it("removes a section, and adds one at the end for a heading no section has", () => {
    const removed = editNotesSection(NOTES, { heading: "### Detail", text: null });
    expect("notes" in removed && removed.notes).toContain("- homework 3\n\n## Pacing");
    const added = editNotesSection(NOTES, { heading: "## Owed", text: "Homework 4." });
    expect("notes" in added && added.notes).toBe(`${NOTES}\n\n## Owed\n\nHomework 4.`);
    expect(editNotesSection("", { heading: "## Owed", text: "Homework 4." })).toEqual({
      notes: "## Owed\n\nHomework 4.",
    });
  });

  it("says why it can't: not a heading, nothing to remove, or more than one match", () => {
    const code = (notes: string, heading: string, text: string | null) => {
      const edited = editNotesSection(notes, { heading, text });
      return "code" in edited ? edited.code : null;
    };
    expect(code(NOTES, "Open threads", "x")).toBe("not-a-heading");
    expect(code(NOTES, "## Missing", null)).toBe("no-section");
    // Inside a code fence, a heading line isn't one.
    expect(code(NOTES, "## not a heading", null)).toBe("no-section");
    expect(code(`${NOTES}\n\n## Pacing\n\nAgain.`, "## Pacing", "x")).toBe("ambiguous-section");
  });
});

describe("applyActions: the plan's notes, edited by section", () => {
  const NOTES = "## Open threads\n\n- homework 3\n\n## Pacing\n\nSlow.";
  const plan = { arcs: [{ title: "Concurrency", terms: [] }], notes: NOTES };

  it("from the close: a section edited, and set-plan changing the arcs only", async () => {
    const trackId = await newTrack();
    await applyActions(t.db, trackId, [{ type: "set-plan", ...plan }], {
      source: "import",
      rewritePlan: true,
    });
    const arcs = [{ title: "Locks", terms: [] }];
    const result = await applyActions(
      t.db,
      trackId,
      [
        { type: "set-plan", arcs, notes: null },
        { type: "edit-plan-notes", heading: "## Open threads", text: "- homework 4" },
      ],
      { source: "close", rewritePlan: true },
    );
    expect(result).toEqual({ ok: true });
    expect((await loadTrackContext(t.db, trackId)).plan).toEqual({
      arcs,
      notes: "## Open threads\n\n- homework 4\n\n## Pacing\n\nSlow.",
    });
  });

  it("rejects an edit it can't place, and leaves it out from a call that didn't see the notes", async () => {
    const trackId = await newTrack();
    await applyActions(t.db, trackId, [{ type: "set-plan", ...plan }], {
      source: "import",
      rewritePlan: true,
    });
    expect(
      await applyActions(
        t.db,
        trackId,
        [{ type: "edit-plan-notes", heading: "## Owed", text: null }],
        { source: "close", rewritePlan: true },
      ),
    ).toEqual({ ok: false, errors: ['The plan\'s notes have no section "## Owed" to remove.'] });
    await applyActions(
      t.db,
      trackId,
      [{ type: "edit-plan-notes", heading: "## Pacing", text: null }],
      { source: "probe" },
    );
    expect((await loadTrackContext(t.db, trackId)).plan).toEqual(plan);
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
      {
        index: 3,
        code: "unknown-term",
        reason: `"TLS" isn't in the term list; add it as a planned term first (or as assumed, if the learner already knew it).`,
      },
      {
        index: 4,
        code: "unknown-rests-on",
        reason: `"QUIC" rests on "UDP", which isn't in the term list.`,
      },
    ]);
  });

  it("says which edit each rejection is for, in batch order, with a code per reason", () => {
    expect(
      validateActions(emptyTrackShape(), [
        { type: "add-to-arc", arc: "Networks", terms: ["TCP"] },
        { type: "close-fix-item", text: "Never recorded" },
        { type: "set-language", language: " " },
        { type: "add-to-arc", arc: "Networks", terms: [] },
      ]).map((r) => [r.index, r.code]),
    ).toEqual([
      [0, "unplaced-term"],
      [1, "no-open-fix-item"],
      [2, "no-language"],
      [3, "empty-arc"],
    ]);
  });
});

describe("applyValidActions", () => {
  it("applies what validates and returns the rest, with an edit that needs a rejected one", async () => {
    const trackId = await newTrack();
    const result = await applyValidActions(
      t.db,
      trackId,
      [
        { type: "add-planned-term", term: "memory", restsOn: [] },
        { type: "add-planned-term", term: "mutex", restsOn: ["semaphore"] },
        { type: "set-term-status", term: "mutex", status: "taught", evidence: "one at a time" },
        { type: "set-term-status", term: "memory", status: "confirmed", evidence: "holds 5" },
        { type: "add-fix-item", text: "Thinks memory can add" },
      ],
      { source: "check s1" },
    );

    expect(result.rejected.map((r) => [r.index, r.code, r.action.type])).toEqual([
      [1, "unknown-rests-on", "add-planned-term"],
      [2, "unknown-term", "set-term-status"],
    ]);
    const context = await loadTrackContext(t.db, trackId);
    expect(context.terms).toEqual([{ term: "memory", status: "confirmed", restsOn: [] }]);
    expect(context.fixList).toEqual([{ text: "Thinks memory can add", status: "open" }]);
  });

  it("writes nothing when nothing validates", async () => {
    const trackId = await newTrack();
    const result = await applyValidActions(
      t.db,
      trackId,
      [{ type: "close-fix-item", text: "Never recorded" }],
      { source: "probe" },
    );
    expect(result.rejected).toHaveLength(1);
    expect(await t.db.select().from(termEvents)).toEqual([]);
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
