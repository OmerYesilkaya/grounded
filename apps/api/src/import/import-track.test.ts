import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { ImportReading } from "@grounded/core";
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
  fixtureReading,
  HANDOFF,
  LATEST_LESSON,
  OWED_HOMEWORK,
  writeLearningFixture,
} from "../test/learning-fixture.js";
import { scriptedModels } from "../test/scripted-models.js";
import { IMPORT_ATTEMPTS, importTrack, type ImportOutcome } from "./import-track.js";
import { ASSUMED_EVIDENCE } from "./ledger.js";
import { formatOutcome, formatReport } from "./report.js";

const t = createTestHarness();
const models = scriptedModels();
const EMAIL = "ada@example.com";

beforeEach(() => {
  models.reset();
});

async function learner(options: { key?: boolean } = {}) {
  const [user] = await t.db.insert(users).values({ email: EMAIL }).returning();
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

const reply = (reading: ImportReading) => ({ text: JSON.stringify(reading) });

/** A dry run; with `write`, then the write of what that dry run showed (as the CLI does). */
async function run(options: { write: boolean; email?: string }) {
  const base = {
    db: t.db,
    models: models.access,
    folder: await writeLearningFixture(),
    email: options.email ?? EMAIL,
  };
  const dry = await importTrack({ ...base, write: false });
  if (!options.write || dry.status !== "ok") return dry;
  return importTrack({ ...base, write: true, reviewed: dry.conversion });
}

function reportOf(outcome: ImportOutcome) {
  if (outcome.status !== "ok")
    throw new Error(`import ${outcome.status}: ${formatOutcome(outcome)}`);
  return outcome.report;
}

const CONDUCTION = "heat moves from the hot pan into the food (conduction)";

describe("importTrack: dry run", () => {
  it("reports what it would import, calls the model once, and writes nothing", async () => {
    await learner();
    models.script("import", reply(fixtureReading()));

    const outcome = await run({ write: false });
    const report = reportOf(outcome);

    expect(report).toMatchObject({
      written: false,
      trackId: null,
      title: "Cooking basics",
      language: "English",
      ledgerCounts: { assumed: 6, confirmed: 3, taught: 2, planned: 7 },
      merged: ["emulsion: taught (also listed as planned)"],
      termCounts: { assumed: 6, confirmed: 3, taught: 2, planned: 6 },
      dependencies: 5,
      arcs: [
        { title: "A — heat (closed)", terms: 4 },
        { title: "B — sauces", terms: 6 },
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

    const printed = formatOutcome(outcome);
    expect(printed).toContain("Dry run");
    expect(printed).toContain("Ledger parsed  6 assumed · 3 confirmed · 2 taught · 7 planned");
    expect(printed).toContain("in two sections: emulsion: taught (also listed as planned)");
    expect(printed).toContain("17: 6 assumed · 3 confirmed · 2 taught · 6 planned");
    expect(printed).toContain("2026-01-03-heat/homework.md");
    expect(printed).toContain("- Re-probe the Maillard reaction cold");
  });

  it("sends the numbered terms, the map, the plan and the open threads, not the ledger", async () => {
    await learner();
    models.script("import", reply(fixtureReading()));
    await run({ write: false });

    const [call] = models.used;
    expect(call?.purpose).toBe("import");
    const prompt = JSON.stringify(call?.model.doStreamCalls[0]?.prompt);
    expect(prompt).toContain(`7. ${CONDUCTION} [confirmed]`);
    expect(prompt).toContain("11. emulsion [taught]");
    expect(prompt).toContain("17. bread crust [planned]");
    expect(prompt).toContain("conduction ──► Maillard reaction");
    expect(prompt).toContain("Arcs: **A** heat (closed)");
    expect(prompt).toContain("Believes salt makes water boil much faster.");
    expect(prompt).toContain("Cooking from first principles.");
    expect(prompt).not.toContain("Session 1 check 2");
  });
});

describe("importTrack: --write", () => {
  it("creates the track with its terms, evidence, map, fix-list, plan notes and last lesson", async () => {
    const user = await learner();
    models.script("import", reply(fixtureReading()));

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
      { term: "boiling water (probe floor)", status: "assumed", restsOn: [] },
      { term: "salt dissolves", status: "assumed", restsOn: [] },
      { term: "a whisk mixes air in", status: "assumed", restsOn: [] },
      { term: "oil floats on water", status: "assumed", restsOn: [] },
      { term: CONDUCTION, status: "confirmed", restsOn: ["stove"] },
      { term: "a lid traps steam", status: "confirmed", restsOn: [] },
      { term: "salt raises the boiling point only slightly", status: "confirmed", restsOn: [] },
      { term: "Maillard reaction", status: "taught", restsOn: [CONDUCTION] },
      {
        term: "emulsion",
        status: "taught",
        restsOn: expect.arrayContaining([
          "a whisk mixes air in",
          "oil floats on water",
        ]) as string[],
      },
      { term: "roux", status: "planned", restsOn: [] },
      { term: "hollandaise", status: "planned", restsOn: ["emulsion"] },
      { term: "mayonnaise", status: "planned", restsOn: [] },
      { term: "beurre blanc", status: "planned", restsOn: [] },
      { term: "pan sauce", status: "planned", restsOn: [] },
      { term: "bread crust", status: "planned", restsOn: [] },
    ]);
    expect(context.fixList).toEqual([
      { text: "Salt makes water boil much faster.", status: "open" },
    ]);

    const evidenceOf = async (name: string) => {
      const [row] = await t.db.select().from(terms).where(eq(terms.term, name));
      const events = await t.db
        .select()
        .from(termEvents)
        .where(eq(termEvents.termId, row?.id ?? ""));
      return events.find((e) => e.fromStatus === "planned");
    };
    const source = "imported from Learning 2026-01-05";
    expect(await evidenceOf(CONDUCTION)).toMatchObject({
      toStatus: "confirmed",
      evidence: 'Session 1 check 2: "the pan warms the egg from below"',
      source,
    });
    expect(await evidenceOf("Maillard reaction")).toMatchObject({
      toStatus: "taught",
      evidence: "Session 2 lesson; check leaked once",
    });
    expect(await evidenceOf("emulsion")).toMatchObject({
      toStatus: "taught",
      evidence: "Session 3 lesson; also listed as planned: from S3",
    });
    expect(await evidenceOf("knife")).toMatchObject({
      toStatus: "assumed",
      evidence: ASSUMED_EVIDENCE,
    });
    expect(await evidenceOf("oil floats on water")).toMatchObject({
      toStatus: "assumed",
      evidence: `${ASSUMED_EVIDENCE} — P1 probe floors (2026-01-04)`,
    });

    const { plan } = context;
    expect(plan.arcs).toEqual([
      {
        title: "A — heat (closed)",
        terms: [
          CONDUCTION,
          "a lid traps steam",
          "salt raises the boiling point only slightly",
          "Maillard reaction",
        ],
      },
      {
        title: "B — sauces",
        terms: ["emulsion", "roux", "hollandaise", "mayonnaise", "beurre blanc", "pan sauce"],
      },
    ]);
    expect(plan.notes).toMatch(/^Arc B has started: sauces next\./);
    expect(plan.notes).toContain("### Open threads carried forward");
    expect(plan.notes).toContain("- Believes salt makes water boil much faster.");
    expect(plan.notes).toContain("### Owed homework: 2026-01-03-heat");
    expect(plan.notes).toContain(
      "Brown two onions, one covered and one not. **Predict** which browns first, then reconcile.",
    );
    // Copied headings sit below the prompt's own.
    expect(plan.notes).toContain("##### Homework: browning");
    expect(plan.notes).toContain(
      "### Planned terms' notes in the ledger\n\n- hollandaise: from S3\n- mayonnaise: from S3\n- beurre blanc: arc B remaining\n- pan sauce: arc B remaining",
    );
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

describe("importTrack: what the reading names", () => {
  it("leaves out and reports ids that name no term and a dependency cycle, instead of failing", async () => {
    await learner();
    const reading = fixtureReading();
    models.script(
      "import",
      reply({
        ...reading,
        dependencies: [
          ...reading.dependencies,
          { term: 99, restsOn: [1] },
          { term: 2, restsOn: [10] },
        ],
        arcs: reading.arcs.map((arc, i) => (i === 0 ? { ...arc, terms: [...arc.terms, 77] } : arc)),
      }),
    );

    const report = reportOf(await run({ write: true }));

    expect(report.written).toBe(true);
    expect(report.unplaced).toEqual([
      "A dependency named term 99, which isn't in the list; left out.",
      `"${CONDUCTION}" was said to rest on "stove", which already rests on it (directly or through other terms): a cycle; that edge was left out.`,
      `Arc "A — heat (closed)" listed term 77, which isn't in the list; left out.`,
      "The map's root 'a stove makes a pan hot' is a sentence, not a term.",
    ]);
    expect(report.arcs[0]).toEqual({ title: "A — heat (closed)", terms: 4 });
    expect(formatReport(report)).toContain("Couldn't place:\n  - A dependency named term 99");
  });
});

describe("importTrack: the write applies what was reviewed", () => {
  it("writes the dry run's result without calling the model again", async () => {
    await learner();
    models.script("import", reply(fixtureReading()));
    const report = reportOf(await run({ write: true }));
    expect(report.written).toBe(true);
    expect(models.used).toHaveLength(1);
  });

  it("refuses a write without a reviewed dry run, before any model call", async () => {
    await learner();
    const outcome = await importTrack({
      db: t.db,
      models: models.access,
      folder: await writeLearningFixture(),
      email: EMAIL,
      write: true,
    });
    expect(outcome).toEqual({
      status: "refused",
      reason:
        "There is no reviewed dry run. Run it without --write first; --write applies exactly what it showed.",
    });
    expect(models.used).toEqual([]);
  });

  it("refuses a dry run saved by an earlier version of the importer", async () => {
    await learner();
    models.script("import", reply(fixtureReading()));
    const folder = await writeLearningFixture();
    const base = { db: t.db, models: models.access, folder, email: EMAIL };
    const dry = await importTrack({ ...base, write: false });
    if (dry.status !== "ok") throw new Error("dry run failed");

    const outcome = await importTrack({
      ...base,
      write: true,
      reviewed: { ...dry.conversion, version: 1 },
    });
    expect(outcome).toEqual({
      status: "refused",
      reason:
        "The saved dry run was made by an earlier version of the importer. Run the dry run again.",
    });
    expect(await t.db.select().from(tracks)).toEqual([]);
  });

  it("refuses when the earlier setup changed since the dry run", async () => {
    await learner();
    models.script("import", reply(fixtureReading()));
    const folder = await writeLearningFixture();
    const base = { db: t.db, models: models.access, folder, email: EMAIL };
    const dry = await importTrack({ ...base, write: false });
    if (dry.status !== "ok") throw new Error("dry run failed");
    await appendFile(join(folder, "state.md"), "\n- one more line\n");

    const outcome = await importTrack({ ...base, write: true, reviewed: dry.conversion });
    expect(outcome).toEqual({
      status: "refused",
      reason: "The earlier setup's files changed since the dry run. Run the dry run again.",
    });
    expect(await t.db.select().from(tracks)).toEqual([]);
  });
});

describe("importTrack: failed replies", () => {
  it("asks again when the reply isn't the requested shape", async () => {
    await learner();
    models.script("import", { text: '{"dependencies": [' }, reply(fixtureReading()));

    const report = reportOf(await run({ write: false }));

    expect(report.attempts).toBe(2);
    const retry = JSON.stringify(models.used[1]?.model.doStreamCalls[0]?.prompt);
    expect(retry).toContain("The reply wasn't a complete object in the requested shape.");
  });

  it("gives up after a bounded number of unusable replies, writing nothing", async () => {
    await learner();
    const broken = { text: '{"arcs": 3}' };
    models.script("import", broken, broken, broken);

    const outcome = await run({ write: true });

    expect(outcome).toEqual({
      status: "rejected",
      attempts: IMPORT_ATTEMPTS,
      errors: ["The reply wasn't a complete object in the requested shape."],
    });
    expect(models.used).toHaveLength(IMPORT_ATTEMPTS);
    expect(await t.db.select().from(tracks)).toEqual([]);
  });

  it("stops at a provider failure instead of paying for more attempts", async () => {
    await learner();
    const failing = new MockLanguageModelV4({
      doStream: () =>
        Promise.resolve({
          stream: simulateReadableStream<LanguageModelV4StreamPart>({
            chunks: [
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: '{"dependencies": [' },
              { type: "error", error: new ProviderCallError("timeout", "Too slow.") },
            ],
          }),
        }),
    });
    models.script("import", failing, reply(fixtureReading()));

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
    await t.db
      .insert(tracks)
      .values({ userId: user.id, title: "cooking BASICS", goal: "cooking BASICS" });
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
