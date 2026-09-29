import {
  and,
  assignments,
  checkMessages,
  eq,
  learningSessions,
  lessons,
  termEvents,
  terms,
} from "@grounded/db";
import { beforeEach, describe, expect, it } from "vitest";
import { FINAL_FOUND } from "./engine/final.js";
import { applyActions } from "./engine/track-state.js";
import type { TrackSummary } from "./track-list.js";
import { createFlows, FIRST_QUESTION, storedMessages } from "./test/flows.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";

const models = scriptedModels();
const t = createTestHarness({ models: models.access });
const { learner, snapshot, until } = createFlows(t, models);

beforeEach(() => {
  models.reset();
});

const post = (cookie: string, path: string, body?: object) =>
  t.request(path, { method: "POST", cookie, ...(body ? { body: JSON.stringify(body) } : {}) });

const OLD_ITEM = "Thinks adding one is a single step";
const FIXED_ITEM = "Thinks two workers take turns by themselves";
const NEW_ITEM = "Thinks a lock makes the work itself faster";

/** A track whose plan is taught through: its one arc's terms held, its first session closed. */
async function taughtThrough() {
  const { cookie, trackId } = await learner();
  const me = (await (await t.request("/api/me", { cookie })).json()) as { id: string };
  const applied = await applyActions(
    t.db,
    trackId,
    [
      { type: "add-planned-term", term: "working copy", restsOn: [] },
      { type: "add-planned-term", term: "lost update", restsOn: ["working copy"] },
      { type: "set-term-status", term: "working copy", status: "confirmed", evidence: "Said so." },
      { type: "set-term-status", term: "lost update", status: "confirmed", evidence: "Said so." },
      { type: "add-to-arc", arc: "Concurrency", terms: ["working copy", "lost update"] },
      { type: "add-fix-item", text: OLD_ITEM },
      { type: "add-fix-item", text: FIXED_ITEM },
      { type: "close-fix-item", text: FIXED_ITEM },
    ],
    { source: "close" },
  );
  if (!applied.ok) throw new Error(applied.errors.join("; "));
  const [first] = await t.db
    .insert(learningSessions)
    .values({
      trackId,
      userId: me.id,
      state: {
        phase: "closed",
        plan: "approved",
        lesson: { status: "ready", steps: [] },
        steps: {},
        currentStep: null,
      },
      closedAt: new Date(),
    })
    .returning();
  return { cookie, trackId, userId: me.id, firstSession: first?.id ?? "" };
}

const trackOf = async (cookie: string, trackId: string) =>
  ((await (await t.request("/api/tracks", { cookie })).json()) as TrackSummary[]).find(
    (track) => track.id === trackId,
  );

/** The prompt of a purpose's nth call, as text. */
const promptOf = (purpose: string, n = 0) => {
  const calls = models.used
    .filter((u) => u.purpose === purpose)
    .flatMap((u) => [...u.model.doStreamCalls, ...u.model.doGenerateCalls]);
  return JSON.stringify(calls[n]?.prompt ?? null);
};

const decided = (output: object) => ({ thenGenerate: [JSON.stringify(output)] });

async function startFinal(cookie: string, trackId: string) {
  const started = await post(cookie, `/api/tracks/${trackId}/sessions`, { kind: "final" });
  expect(started.status).toBe(201);
  return ((await started.json()) as { id: string }).id;
}

describe("the final", () => {
  it("is offered once the plan is taught through, and not before", async () => {
    const { cookie, trackId } = await learner();
    expect((await trackOf(cookie, trackId))?.final).toBe("not-yet");
    const refused = await post(cookie, `/api/tracks/${trackId}/sessions`, { kind: "final" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: "The final comes once the plan is taught through.",
    });
  });

  it("waits for an arc exam still open", async () => {
    const track = await taughtThrough();
    await t.db.insert(assignments).values({
      trackId: track.trackId,
      userId: track.userId,
      sessionId: track.firstSession,
      kind: "exam",
      title: "Counters everywhere",
      tasks: [{ id: "t1", title: null, form: "explain", blocks: [], source: "Explain it." }],
      checklist: [{ id: "c1", text: "Sees it in a new setting" }],
      messageId: crypto.randomUUID(),
    });
    expect((await trackOf(track.cookie, track.trackId))?.final).toBe("after-exam");
    const refused = await post(track.cookie, `/api/tracks/${track.trackId}/sessions`, {
      kind: "final",
    });
    expect(await refused.json()).toMatchObject({
      error: "The final comes once your arc exam is handed in.",
    });
  });

  it("runs a cold audit, then a teach-back, and closes with the two fix-lists compared", async () => {
    const { cookie, trackId } = await taughtThrough();
    expect((await trackOf(cookie, trackId))?.final).toBe("ready");
    models.script("audit", { text: "The final: in your own words, what is a working copy?" });
    const sessionId = await startFinal(cookie, trackId);
    await until(cookie, sessionId, storedMessages(1));
    let s = await snapshot(cookie, sessionId);
    expect(s.state).toMatchObject({ kind: "final", phase: "audit" });
    expect(s.messages[0]).toMatchObject({ role: "tutor", kind: "audit" });
    // Cold: the audit doesn't see the fix-list the track kept.
    expect(promptOf("audit")).toContain("This part of the final: the fresh audit");
    expect(promptOf("audit")).not.toContain(OLD_ITEM);

    // Its misconceptions are the new fix-list.
    models.script(
      "audit-decision",
      decided({ actions: [{ type: "add-fix-item", text: NEW_ITEM }], finished: false }),
    );
    models.script("audit", { text: "And what does a lock change?" });
    await post(cookie, `/api/sessions/${sessionId}/messages`, { text: "a copy you work on" });
    await until(cookie, sessionId, storedMessages(3));
    expect((await snapshot(cookie, sessionId)).messages[1]).toMatchObject({ kind: "audit" });

    // Done, it hands over to the teach-back.
    models.script("audit-decision", decided({ actions: [], finished: true }));
    models.script("teach-back", { text: "Now rebuild it for me, from the ground up." });
    await post(cookie, `/api/sessions/${sessionId}/messages`, { text: "it makes it faster" });
    await until(cookie, sessionId, storedMessages(5));
    s = await snapshot(cookie, sessionId);
    expect(s.state.phase).toBe("teach-back");
    expect(s.messages[4]).toMatchObject({ role: "tutor", kind: "teach-back" });
    expect(promptOf("teach-back")).toContain("This part of the final: the teach-back");

    // A break takes its term back to taught; then the close.
    models.script(
      "teach-back-decision",
      decided({
        actions: [],
        breaks: [{ term: "working copy", quote: "you just copy it, it just is" }],
        finished: true,
      }),
    );
    models.script("close", { text: "Here is where it held, and where it broke." });
    models.script("term-sweep", { thenGenerate: [JSON.stringify({ actions: [] })] });
    models.script("left-off", { text: "The new fix-list is open." });
    await post(cookie, `/api/sessions/${sessionId}/messages`, { text: "you just copy it" });
    await until(cookie, sessionId, (x) => x.state.phase === "closed");
    s = await snapshot(cookie, sessionId);
    expect(s.messages.at(-1)).toMatchObject({ role: "tutor", kind: "recap" });

    const [copy] = await t.db
      .select()
      .from(terms)
      .where(and(eq(terms.trackId, trackId), eq(terms.term, "working copy")));
    expect(copy?.status).toBe("taught");
    const events = await t.db
      .select()
      .from(termEvents)
      .where(eq(termEvents.termId, copy?.id ?? ""));
    expect(events.at(-1)).toMatchObject({
      source: "teach-back",
      evidence: "Couldn't say why in the final's teach-back: “you just copy it, it just is”",
    });
    // The close hears both lists and the breaks, and reads the notes as written.
    const recap = promptOf("close");
    expect(recap).toContain(FINAL_FOUND);
    expect(recap).toContain(`- [open] ${OLD_ITEM}`);
    expect(recap).toContain(`- [closed] ${FIXED_ITEM}`);
    expect(recap).toContain(`- [open] ${NEW_ITEM}`);
    expect(recap).toContain("In working copy: “you just copy it, it just is”");

    const outcome = await (await t.request(`/api/sessions/${sessionId}/final`, { cookie })).json();
    expect(outcome).toMatchObject({
      before: [
        { text: OLD_ITEM, open: true },
        { text: FIXED_ITEM, open: false },
      ],
      found: [{ text: NEW_ITEM, open: true }],
      breaks: [{ term: "working copy", quote: "you just copy it, it just is" }],
    });
    const track = await trackOf(cookie, trackId);
    expect(track).toMatchObject({ final: "finished", finishedIn: sessionId });
    expect(track?.items.at(-1)).toMatchObject({ kind: "session", final: true, done: true });

    // A session after it takes up the new list; the track isn't finished any more.
    models.script("probe", { text: FIRST_QUESTION });
    expect((await post(cookie, `/api/tracks/${trackId}/sessions`)).status).toBe(201);
    expect((await trackOf(cookie, trackId))?.final).toBe("ready");
  });

  it("opens with the review when something waits, then hands over to the audit", async () => {
    const track = await taughtThrough();
    // The first session went past a step while still shaky.
    await t.db
      .update(learningSessions)
      .set({
        state: {
          phase: "closed",
          plan: "approved",
          lesson: {
            status: "ready",
            steps: [{ id: "s1", check: { steps: ["s1"], terms: [], gates: true } }],
          },
          steps: { s1: { status: "settling", misses: 2, offerGate: false } },
          currentStep: null,
        },
      })
      .where(eq(learningSessions.id, track.firstSession));
    await t.db.insert(lessons).values({
      sessionId: track.firstSession,
      stepSources: { s1: "## The working copy\n\nIt is copied.\n\n:::check\nWhy?\n:::" },
    });
    await t.db.insert(checkMessages).values({
      sessionId: track.firstSession,
      stepId: "s1",
      role: "learner",
      text: "no idea",
    });
    models.script("opening-review", { text: "Last time the working copy was shaky. Is it now?" });
    const sessionId = await startFinal(track.cookie, track.trackId);
    await until(track.cookie, sessionId, storedMessages(1));
    expect((await snapshot(track.cookie, sessionId)).state).toMatchObject({
      kind: "final",
      phase: "review",
    });
    models.script(
      "opening-review-decision",
      decided({ actions: [], resolved: [], finished: true }),
    );
    models.script("opening-review-summary", { text: "It held." });
    models.script("audit", { text: "Thanks. The final: what is a working copy?" });
    await post(track.cookie, `/api/sessions/${sessionId}/messages`, { text: "a copy" });
    await until(track.cookie, sessionId, storedMessages(3));
    const s = await snapshot(track.cookie, sessionId);
    expect(s.state.phase).toBe("audit");
    expect(s.messages.map((m) => m.kind)).toEqual(["review", "review", "audit"]);
    expect(promptOf("audit")).toContain("The review is over");
  });
});
