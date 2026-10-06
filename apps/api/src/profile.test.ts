import { initialSession } from "@grounded/core";
import {
  assignments,
  eq,
  learnerProfileNotes,
  learningSessions,
  profileRefreshes,
  reviews,
  sessionMessages,
  tracks,
  users,
} from "@grounded/db";
import { beforeEach, describe, expect, it } from "vitest";
import {
  profileDue,
  profileEvidence,
  reviewedSinceRefresh,
  sessionsSinceRefresh,
  settleNotes,
  type CurrentNote,
} from "./engine/profile.js";
import { loadTrackContext } from "./engine/track-state.js";
import type { About, TeachingNote } from "./routes/profile.js";
import { createFlows } from "./test/flows.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";

const models = scriptedModels();
const t = createTestHarness({ models: models.access });
const { learner } = createFlows(t, models);

beforeEach(() => {
  models.reset();
});

const DAY = 86_400_000;

const ownerOf = async (trackId: string) =>
  (await t.db.select().from(tracks).where(eq(tracks.id, trackId)))[0]?.userId ?? "";

/** The learner's closed sessions in a track, a day apart and oldest first, each with a recap. */
async function closedSessions(trackId: string, count: number, from = Date.now() - 60 * DAY) {
  const userId = await ownerOf(trackId);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const at = new Date(from + i * DAY);
    const [row] = await t.db
      .insert(learningSessions)
      .values({
        trackId,
        userId,
        state: { ...initialSession(), phase: "closed" },
        createdAt: at,
        closedAt: new Date(at.getTime() + 3_600_000),
      })
      .returning();
    if (!row) throw new Error("no session");
    await t.db.insert(sessionMessages).values({
      sessionId: row.id,
      role: "tutor",
      kind: "recap",
      text: `Recap ${String(i + 1)}: the example came first, then the rule.`,
      createdAt: new Date(at.getTime() + 1_800_000),
    });
    ids.push(row.id);
  }
  return ids;
}

const note = (id: string, text: string, sessions: string[] = []): CurrentNote => ({
  id,
  text,
  evidence: sessions.map((sessionId) => ({ sessionId, what: "seen" })),
  byLearner: false,
});
const labels = new Map([
  ["S1", "a"],
  ["S2", "b"],
  ["S3", "c"],
]);
const cite = (...sessions: string[]) => sessions.map((session) => ({ session, what: "seen" }));

describe("settling a refresh into the notes", () => {
  it("revises a note it keeps, removes one it leaves out, and adds a pattern of three sessions", () => {
    const current = [note("n1", "Examples first.", ["old"]), note("n2", "Likes long lessons.")];
    const changes = settleNotes(
      current,
      {
        notes: [
          { keeps: "N1", text: "One concrete example before the rule.", evidence: cite("S2") },
          { keeps: null, text: "Predict, then run it.", evidence: cite("S1", "S2", "S3") },
          { keeps: null, text: "Two sessions are not a pattern.", evidence: cite("S1", "S2") },
          { keeps: null, text: "Unknown sessions don't count.", evidence: cite("S1", "S2", "S9") },
        ],
      },
      labels,
    );
    expect(changes.revised).toEqual([
      {
        id: "n1",
        text: "One concrete example before the rule.",
        evidence: [
          { sessionId: "old", what: "seen" },
          { sessionId: "b", what: "seen" },
        ],
      },
    ]);
    expect(changes.removed).toEqual(["n2"]);
    expect(changes.added.map((n) => n.text)).toEqual(["Predict, then run it."]);
  });

  it("keeps to about a dozen notes", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      keeps: null,
      text: `Note ${String(i)}`,
      evidence: cite("S1", "S2", "S3"),
    }));
    expect(settleNotes([], { notes: many }, labels).added).toHaveLength(12);
  });
});

describe("the learner's teaching notes (#44)", () => {
  it("are first due after six closed sessions across tracks, then about every five", async () => {
    const { trackId } = await learner();
    const userId = await ownerOf(trackId);
    await closedSessions(trackId, 5);
    expect(await profileDue(t.db, userId)).toBe(false);
    const [sixth] = await closedSessions(trackId, 1, Date.now() - 30 * DAY);
    expect(await profileDue(t.db, userId)).toBe(true);

    await t.db
      .insert(profileRefreshes)
      .values({ userId, sessionId: sixth ?? null, createdAt: new Date(Date.now() - 25 * DAY) });
    await closedSessions(trackId, 4, Date.now() - 20 * DAY);
    expect(await profileDue(t.db, userId)).toBe(false);
    await closedSessions(trackId, 1, Date.now() - 10 * DAY);
    expect(await profileDue(t.db, userId)).toBe(true);
  });

  it("are refreshed from the evidence since, and every call of the learner carries them", async () => {
    const { trackId } = await learner();
    const userId = await ownerOf(trackId);
    const sessions = await closedSessions(trackId, 6);
    await t.db.insert(learnerProfileNotes).values([
      { userId, text: "Prefers long lessons." },
      { userId, text: "Examples first.", byLearner: true },
    ]);
    await t.db
      .update(users)
      .set({ about: "Backend developer, eight years." })
      .where(eq(users.id, userId));
    const refresh = {
      notes: [
        { keeps: "N2", text: "One concrete example before the rule.", evidence: cite("S4") },
        {
          keeps: null,
          text: "Predict what happens, then run it.",
          evidence: cite("S1", "S3", "S5"),
        },
      ],
    };
    models.script("profile", { thenGenerate: [JSON.stringify(refresh)] });
    await t.queue.enqueue("profile", { sessionId: sessions[5] ?? "" });
    await t.waitFor(
      async () =>
        (await t.db.select().from(profileRefreshes).where(eq(profileRefreshes.userId, userId)))
          .length === 1,
    );

    // It read the notes as they stood and each session's evidence, labelled for citing.
    const prompt = JSON.stringify(models.used[0]?.model.doGenerateCalls[0]?.prompt);
    expect(prompt).toContain("N2: Examples first. (the learner wrote or edited it)");
    expect(prompt).toContain(
      "## What the learner wrote about themselves\\n\\nBackend developer, eight years.",
    );
    expect(prompt).toContain("## S6: Concurrency");
    expect(prompt).toContain("Recap 6: the example came first");

    const notes = (await (
      await t.request("/api/profile/notes", { cookie: await t.signIn("ada@example.com") })
    ).json()) as TeachingNote[];
    expect(notes.map((n) => [n.text, n.byLearner])).toEqual([
      ["One concrete example before the rule.", false],
      ["Predict what happens, then run it.", false],
    ]);
    expect(notes[1]?.evidence.map((e) => e.session?.number)).toEqual([1, 3, 5]);
    expect(notes[1]?.evidence[0]?.session?.trackTitle).toBe("Concurrency");

    const context = await loadTrackContext(t.db, trackId);
    expect(context.teachingNotes).toEqual([
      "One concrete example before the rule.",
      "Predict what happens, then run it.",
    ]);
    expect(context.about).toBe("Backend developer, eight years.");
  });

  it("hear the reviews of what was handed in, a session's reviewed after the last refresh too", async () => {
    const { trackId } = await learner();
    const userId = await ownerOf(trackId);
    const [before] = await closedSessions(trackId, 1, Date.now() - 40 * DAY);
    const [since] = await closedSessions(trackId, 1, Date.now() - 30 * DAY);
    await t.db
      .insert(profileRefreshes)
      .values({ userId, sessionId: before ?? null, createdAt: new Date(Date.now() - 35 * DAY) });
    for (const [sessionId, title] of [
      [before, "Put off, handed in later"],
      [since, "Handed in at once"],
    ] as const) {
      const [assignment] = await t.db
        .insert(assignments)
        .values({
          trackId,
          userId,
          sessionId: sessionId ?? "",
          kind: "homework",
          title,
          tasks: [{ id: "t1", title: null, form: "explain", blocks: [], source: "Explain it." }],
          checklist: [{ id: "c1", text: "Why adding one is three moves" }],
          messageId: crypto.randomUUID(),
          submittedAt: new Date(),
        })
        .returning();
      await t.db.insert(reviews).values({
        assignmentId: assignment?.id ?? "",
        status: "done",
        checklist: [{ id: "c1", mark: "missing", note: "" }],
        reviewedAt: new Date(),
      });
    }

    const evidence = await profileEvidence(
      t.db,
      await sessionsSinceRefresh(t.db, userId),
      await reviewedSinceRefresh(t.db, userId),
    );
    expect([...evidence.labels.values()]).toEqual([since, before]);
    expect(evidence.text).toContain('### "Handed in at once" (homework)');
    expect(evidence.text).toContain("(only what was handed in since)");
    expect(evidence.text).toContain('### "Put off, handed in later" (homework)');
    expect(evidence.text).toContain("- missing: Why adding one is three moves");
    // The session from before the refresh brings only its review, not its recap again.
    expect(evidence.text.split("Recap 1:").length).toBe(2);
  });

  it("are the learner's to add, edit and remove, and nobody else's", async () => {
    const { cookie } = await learner();
    const send = (path: string, method: string, body?: object) =>
      t.request(path, { method, cookie, ...(body ? { body: JSON.stringify(body) } : {}) });
    const added = await send("/api/profile/notes", "POST", { text: "  Pictures help me.  " });
    expect(added.status).toBe(201);
    const [mine] = (await added.json()) as TeachingNote[];
    expect(mine).toMatchObject({ text: "Pictures help me.", byLearner: true, evidence: [] });
    expect((await send("/api/profile/notes", "POST", { text: " " })).status).toBe(400);

    const id = mine?.id ?? "";
    const edited = await send(`/api/profile/notes/${id}`, "PATCH", { text: "Diagrams help." });
    expect(((await edited.json()) as TeachingNote[]).map((n) => n.text)).toEqual([
      "Diagrams help.",
    ]);

    const eve = await t.signIn("eve@example.com");
    const theirs = await t.request(`/api/profile/notes/${id}`, {
      method: "PATCH",
      cookie: eve,
      body: JSON.stringify({ text: "Mine now." }),
    });
    expect(theirs.status).toBe(404);
    expect(await (await t.request("/api/profile/notes", { cookie: eve })).json()).toEqual([]);

    expect(await (await send(`/api/profile/notes/${id}`, "DELETE")).json()).toEqual([]);
  });

  it("carry what the learner wrote about themselves, theirs alone, in every call", async () => {
    const { cookie, trackId } = await learner();
    const read = async () =>
      (await (await t.request("/api/profile/about", { cookie })).json()) as About;
    const write = (text: string) =>
      t.request("/api/profile/about", { method: "PUT", cookie, body: JSON.stringify({ text }) });
    expect(await read()).toEqual({ text: null });
    expect((await loadTrackContext(t.db, trackId)).about).toBeUndefined();

    const written = await write("  Backend developer, eight years; Node and Postgres daily.  ");
    expect(await written.json()).toEqual({
      text: "Backend developer, eight years; Node and Postgres daily.",
    });
    expect((await loadTrackContext(t.db, trackId)).about).toBe(
      "Backend developer, eight years; Node and Postgres daily.",
    );

    const long = await write("a".repeat(2_001));
    expect(long.status).toBe(400);
    expect(((await long.json()) as { error: { code: string } }).error.code).toBe("about-length");

    const eve = await t.signIn("eve@example.com");
    expect(await (await t.request("/api/profile/about", { cookie: eve })).json()).toEqual({
      text: null,
    });

    expect(await (await write("   ")).json()).toEqual({ text: null });
    expect(await read()).toEqual({ text: null });
  });
});
