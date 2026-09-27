import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { ImportActions } from "@grounded/core";
import {
  credentials,
  eq,
  importedLessons,
  termEvents,
  terms,
  tracks,
  usageEvents,
  users,
} from "@grounded/db";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { ProviderCallError } from "../engine/model-call.js";
import { loadTrackContext } from "../engine/track-state.js";
import { createTestHarness } from "../test/harness.js";
import {
  fixtureConversion,
  HANDOFF,
  LATEST_LESSON,
  OWED_HOMEWORK,
  writeLearningFixture,
} from "../test/learning-fixture.js";
import { scriptedModels } from "../test/scripted-models.js";
import { IMPORT_ATTEMPTS, importTrack, type ImportOutcome } from "./import-track.js";
import { formatOutcome } from "./report.js";

const t = createTestHarness();
const models = scriptedModels();
const EMAIL = "ada@example.com";

beforeEach(() => {
  models.reset();
});

async function learner(options: { key?: boolean } = {}) {
  const [user] = await t.db.insert(users).values({ name: "Ada", email: EMAIL }).returning();
  if (!user) throw new Error("no user");
  if (options.key ?? true) {
    await t.db.insert(credentials).values({
      userId: user.id,
      provider: "anthropic",
      model: "claude-opus-5-5",
      sealedKey: t.vault.seal("sk-ant-test-key", user.id),
      keyHint: "-key",
    });
  }
  return user;
}

const reply = (conversion: ImportActions) => ({ text: JSON.stringify(conversion) });

async function run(options: { write: boolean; email?: string }) {
  return importTrack({
    db: t.db,
    models: models.access,
    folder: await writeLearningFixture(),
    email: options.email ?? EMAIL,
    write: options.write,
  });
}

function reportOf(outcome: ImportOutcome) {
  if (outcome.status !== "ok")
    throw new Error(`import ${outcome.status}: ${formatOutcome(outcome)}`);
  return outcome.report;
}

describe("importTrack: dry run", () => {
  it("reports what it would import, calls the model once, and writes nothing", async () => {
    await learner();
    models.script("import", reply(fixtureConversion()));

    const report = reportOf(await run({ write: false }));

    expect(report).toMatchObject({
      written: false,
      trackId: null,
      title: "Cooking basics",
      language: "English",
      termCounts: { assumed: 3, confirmed: 1, taught: 1, planned: 2 },
      dependencies: 2,
      arcs: [
        { title: "A — heat (closed)", terms: 2 },
        { title: "B — sauces", terms: 2 },
      ],
      fixItems: ["Salt makes water boil much faster."],
      owedHomework: { folder: "2026-01-03-heat", length: OWED_HOMEWORK.length },
      otherUnansweredHomework: ["2026-01-02-stocks"],
      latestLesson: {
        folder: "2026-01-05-sauces",
        title: "Sauces & emulsions — 2026-01-05",
        length: LATEST_LESSON.length,
      },
      unplaced: ["The map's root 'a stove makes a pan hot' is a sentence, not a term."],
      missing: [],
      attempts: 1,
    });
    expect(report.openThreads).toContain("Believes salt makes water boil much faster.");
    expect(models.used).toHaveLength(1);
    expect(await t.db.select().from(tracks)).toEqual([]);
    expect(await t.db.select().from(importedLessons)).toEqual([]);

    const printed = formatOutcome({ status: "ok", report });
    expect(printed).toContain("Dry run");
    expect(printed).toContain("7: 3 assumed · 1 confirmed · 1 taught · 2 planned");
    expect(printed).toContain("2026-01-03-heat/homework.md");
    expect(printed).toContain("- Re-probe the Maillard reaction cold");
  });

  it("sends the state, the handoff and the README row to the learner's strong model", async () => {
    await learner();
    models.script("import", reply(fixtureConversion()));
    await run({ write: false });

    const [call] = models.used;
    expect(call?.purpose).toBe("import");
    const prompt = JSON.stringify(call?.model.doStreamCalls[0]?.prompt);
    expect(prompt).toContain("heat moves from the hot pan into the food (conduction)");
    expect(prompt).toContain("Arc A closed; arc B started.");
    expect(prompt).toContain("Cooking from first principles.");
  });
});

describe("importTrack: --write", () => {
  it("creates the track with its terms, evidence, map, fix-list, plan notes and last lesson", async () => {
    const user = await learner();
    models.script("import", reply(fixtureConversion()));

    const report = reportOf(await run({ write: true }));

    expect(report.written).toBe(true);
    const [track] = await t.db.select().from(tracks).where(eq(tracks.userId, user.id));
    if (!track) throw new Error("no track");
    expect(report.trackId).toBe(track.id);
    const context = await loadTrackContext(t.db, track.id);
    expect(context.track).toEqual({ title: "Cooking basics", language: "English" });
    expect(context.terms).toEqual([
      { term: "knife", status: "assumed", restsOn: [] },
      { term: "stove", status: "assumed", restsOn: [] },
      { term: "boiling water", status: "assumed", restsOn: [] },
      { term: "conduction", status: "confirmed", restsOn: ["stove"] },
      { term: "Maillard reaction", status: "taught", restsOn: ["conduction"] },
      { term: "emulsion", status: "planned", restsOn: [] },
      { term: "roux", status: "planned", restsOn: [] },
    ]);
    expect(context.fixList).toEqual([
      { text: "Salt makes water boil much faster.", status: "open" },
    ]);

    const [conduction] = await t.db.select().from(terms).where(eq(terms.term, "conduction"));
    const events = await t.db
      .select()
      .from(termEvents)
      .where(eq(termEvents.termId, conduction?.id ?? ""));
    expect(events.find((e) => e.toStatus === "confirmed")).toMatchObject({
      fromStatus: "planned",
      evidence: expect.stringContaining('"the pan warms the egg from below"') as string,
      source: "imported from Learning 2026-01-05",
    });

    const { plan } = context;
    expect(plan.arcs.map((a) => a.title)).toEqual(["A — heat (closed)", "B — sauces"]);
    expect(plan.notes).toMatch(/^Arc B has started: sauces next\./);
    expect(plan.notes).toContain("### Open threads carried forward");
    expect(plan.notes).toContain("- Believes salt makes water boil much faster.");
    expect(plan.notes).toContain("### Owed homework: 2026-01-03-heat");
    expect(plan.notes).toContain(
      "Brown two onions, one covered and one not. **Predict** which browns first, then reconcile.",
    );
    // Copied headings sit below the prompt's own.
    expect(plan.notes).toContain("##### Homework: browning");
    expect(plan.notes).toContain("### Session log");
    expect(plan.notes).toContain("| 2026-01-03-heat | browning | assigned |");
    expect(plan.notes).toContain("Arcs: **A** heat (closed) → **B** sauces");
    expect(plan.notes).toContain("### Handoff notes");
    expect(plan.notes).toContain(HANDOFF.split("\n")[4]);
    expect(plan.notes).toContain("### The last lesson: 2026-01-05-sauces");
    expect(plan.notes).toContain("It isn't in the session log");

    expect(await t.db.select().from(importedLessons)).toEqual([
      expect.objectContaining({
        trackId: track.id,
        title: "Sauces & emulsions — 2026-01-05",
        source: "2026-01-05-sauces",
        html: LATEST_LESSON,
      }),
    ]);
  });
});

describe("importTrack: rejected edits", () => {
  it("feeds the reasons back and retries", async () => {
    await learner();
    const [language, ...rest] = fixtureConversion().actions;
    if (!language) throw new Error("no actions");
    const outOfOrder: ImportActions = {
      actions: [
        language,
        { type: "add-planned-term", term: "sear", restsOn: ["Maillard reaction"] },
        ...rest,
      ],
      unplaced: [],
    };
    models.script("import", reply(outOfOrder), reply(fixtureConversion()));

    const report = reportOf(await run({ write: true }));

    expect(report.attempts).toBe(2);
    expect(models.used).toHaveLength(2);
    const retry = JSON.stringify(models.used[1]?.model.doStreamCalls[0]?.prompt);
    expect(retry).toContain(
      `\\"sear\\" rests on \\"Maillard reaction\\", which isn't in the term list.`,
    );
    expect(await t.db.select().from(tracks)).toHaveLength(1);
  });

  it("asks for a language and exactly one plan whose arcs name known terms", async () => {
    await learner();
    const actions = fixtureConversion().actions.filter((a) => a.type !== "set-language");
    const broken: ImportActions = {
      actions: actions.map((a) =>
        a.type === "set-plan" ? { ...a, arcs: [{ title: "C — bread", terms: ["yeast"] }] } : a,
      ),
      unplaced: [],
    };
    models.script("import", reply(broken), reply(broken), reply(broken));

    const outcome = await run({ write: true });

    expect(outcome).toEqual({
      status: "rejected",
      attempts: IMPORT_ATTEMPTS,
      errors: [
        "Set the teaching language (set-language).",
        `Arc "C — bread" lists "yeast", which isn't in the term list.`,
      ],
    });
    expect(models.used).toHaveLength(IMPORT_ATTEMPTS);
    expect(await t.db.select().from(tracks)).toEqual([]);
  });
});

describe("importTrack: failed replies", () => {
  it("asks again when the reply isn't the requested shape", async () => {
    await learner();
    models.script("import", { text: '{"actions": [' }, reply(fixtureConversion()));

    const report = reportOf(await run({ write: false }));

    expect(report.attempts).toBe(2);
    const retry = JSON.stringify(models.used[1]?.model.doStreamCalls[0]?.prompt);
    expect(retry).toContain("The reply wasn't a complete object in the requested shape.");
  });

  it("stops at a provider failure instead of paying for more attempts", async () => {
    await learner();
    const failing = new MockLanguageModelV4({
      doStream: () =>
        Promise.resolve({
          stream: simulateReadableStream<LanguageModelV4StreamPart>({
            chunks: [
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: '{"actions": [' },
              { type: "error", error: new ProviderCallError("timeout", "Too slow.") },
            ],
          }),
        }),
    });
    models.script("import", failing, reply(fixtureConversion()));

    await expect(run({ write: true })).rejects.toThrow("Too slow.");
    expect(models.used).toHaveLength(1);
    expect(await t.db.select().from(tracks)).toEqual([]);
  });
});

describe("importTrack: refusals", () => {
  it("refuses a learner without a key, before any model call", async () => {
    await learner({ key: false });
    const outcome = await run({ write: true });
    expect(outcome).toEqual({
      status: "refused",
      reason: `${EMAIL} has no AI key. The import runs on their model: add one in Settings.`,
    });
    expect(models.used).toEqual([]);
    expect(await t.db.select().from(usageEvents)).toEqual([]);
  });

  it("refuses when the learner already has a track with that title", async () => {
    const user = await learner();
    await t.db.insert(tracks).values({ userId: user.id, title: "cooking BASICS" });
    const outcome = await run({ write: true });
    expect(outcome).toEqual({
      status: "refused",
      reason: `${EMAIL} already has a track called "Cooking basics".`,
    });
    expect(models.used).toEqual([]);
  });

  it("refuses an email nobody signed up with", async () => {
    const outcome = await run({ write: false, email: "Nobody@Example.com" });
    expect(outcome).toEqual({
      status: "refused",
      reason: "No learner signed up as nobody@example.com. They sign in once first.",
    });
  });
});
