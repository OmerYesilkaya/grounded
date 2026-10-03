import type { SourceSectionView } from "@grounded/core";
import { eq, learningSessions, lessons, sourceSections, tracks, users } from "@grounded/db";
import { beforeEach, describe, expect, it } from "vitest";
import { SURVEYING } from "./engine/source-tasks.js";
import { createTrack } from "./files/track-files.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";
import {
  createFlows,
  finishProbe,
  FIRST_QUESTION,
  PLAN_ACTIONS,
  PLAN_TEXT,
  storedMessages,
} from "./test/flows.js";
import { bookPdf, prose } from "./test/files.js";

/*
 * A track taught from its source (design §4.6): every call knows the source's map, the plan is
 * mapped onto its sections, and the lesson teaches from the sections' text and cites them.
 */

const models = scriptedModels();
const t = createTestHarness({ models: models.access });
const { snapshot, until } = createFlows(t, models);

beforeEach(() => {
  models.reset();
});

const SECTIONS = [
  { title: "Opening pages", pages: "p. 1", summary: "The preface." },
  {
    title: "Counters",
    pages: "pp. 2–30",
    summary: "How a counter is copied, changed and put back.",
  },
  { title: "Locks", pages: "pp. 31–60", summary: "How a lock keeps two writers apart." },
];

/** A learner with a track whose source is read: three sections of a PDF. */
const sourceTrack = async () => {
  const cookie = await t.signIn("ada@example.com");
  const [user] = await t.db.select().from(users).where(eq(users.email, "ada@example.com"));
  if (!user) throw new Error("no user");
  const bytes = await bookPdf({ pages: [prose("counters", 30)] });
  const track = await createTrack(
    t.db,
    t.files,
    {
      userId: user.id,
      goal: "My course's set text",
      title: "Concurrency in Practice",
      source: { ...SURVEYING, status: "ready", pages: 60, sections: 3, summarized: 3 },
    },
    [{ name: "concurrency.pdf", kind: "pdf", mediaType: "application/pdf", bytes, pages: 60 }],
    "source",
  );
  const [file] = await t.db.query.trackFiles.findMany({
    where: (f, { eq: is }) => is(f.trackId, track.id),
  });
  if (!file) throw new Error("no file");
  await t.db.insert(sourceSections).values(
    SECTIONS.map((s, i) => ({
      ...s,
      trackId: track.id,
      fileId: file.id,
      n: i + 1,
      pageStart: i === 0 ? 1 : i === 1 ? 2 : 31,
      text: `[p. ${String(i * 30 || 1)}]\nThe text of ${s.title}: a value is copied out, changed and put back.`,
    })),
  );
  return { cookie, trackId: track.id, fileId: file.id };
};

const PLAN_MAP = {
  arcs: [{ title: "Concurrency", sections: [2, 3, 99] }],
  known: [1],
  session: [2],
};

const OUTLINE = {
  title: "Why two writers lose an update",
  steps: [
    {
      heading: "Adding one is three moves",
      establishes: "copy, change, put back",
      introduces: ["working copy"],
      restsOn: [],
    },
  ],
};
const STEP = [
  "## Adding one is three moves",
  'The book says the value is copied out, changed, and put back (p. 30):cite[1].\n\n:::word{term="working copy"}\nThe copy of a value that is changed before it is put back.\n:::',
  ":::check\nWhat is in memory meanwhile?\n:::",
].join("\n\n");

describe("teaching a track from its source", () => {
  it("probes on the source, maps the plan onto its sections, and teaches the lesson from their text", async () => {
    const { cookie, trackId, fileId } = await sourceTrack();
    models.enableSearch();

    // The probe: the source's map and the method's rules for a source track are in its prompt.
    models.script("probe", { text: FIRST_QUESTION });
    const started = await t.request(`/api/tracks/${trackId}/sessions`, { method: "POST", cookie });
    const { id: sessionId } = (await started.json()) as { id: string };
    await until(cookie, sessionId, storedMessages(1));
    const probe = JSON.stringify(
      models.used.find((u) => u.purpose === "probe")?.model.doStreamCalls[0]?.prompt,
    );
    expect(probe).toContain("## The source");
    expect(probe).toContain(
      "§2 Counters (pp. 2–30): How a counter is copied, changed and put back.",
    );
    expect(probe).toContain("## Tracks taught from a source");
    expect(probe).toContain(
      "The learner started a session to learn from the source they brought: concurrency.pdf. Why they are reading it, in their words: My course's set text",
    );

    // The plan: research only for the groundwork, then the plan, its record and its map.
    finishProbe(models);
    models.script(
      "plan",
      { searches: ["binary numbers"], text: "NOTES: groundwork." },
      {
        text: PLAN_TEXT,
        thenGenerate: [JSON.stringify({ actions: PLAN_ACTIONS }), JSON.stringify(PLAN_MAP)],
      },
    );
    await t.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ text: "I've read the first chapter" }),
    });
    await until(cookie, sessionId, (s) => s.state.plan === "proposed");
    const [researcher] = models.used.filter((u) => u.purpose === "plan").map((u) => u.model);
    expect(JSON.stringify(researcher?.doStreamCalls[0]?.prompt)).toContain(
      "check with web search only the groundwork the learner lacks that the source assumes",
    );
    const [track] = await t.db.select().from(tracks).where(eq(tracks.id, trackId));
    // A section the source doesn't have is left out of the map.
    expect(track?.sourceMap).toEqual({
      arcs: [{ title: "Concurrency", sections: [2, 3] }],
      known: [1],
    });
    const [session] = await t.db
      .select()
      .from(learningSessions)
      .where(eq(learningSessions.id, sessionId));
    expect(session?.sourceSections).toEqual([2]);

    // The lesson: the section's text instead of web research, cited as the source's section.
    models.script("lesson", { text: STEP, thenGenerate: [JSON.stringify(OUTLINE)] });
    await t.request(`/api/sessions/${sessionId}/approve-plan`, { method: "POST", cookie });
    await until(cookie, sessionId, (s) => s.lesson?.steps.length === 1);
    const lessonCalls = models.used.filter((u) => u.purpose === "lesson");
    expect(lessonCalls).toHaveLength(1);
    const writing = JSON.stringify(lessonCalls[0]?.model.doStreamCalls[0]?.prompt);
    expect(writing).toContain("The text of Counters: a value is copied out");
    expect(writing).not.toContain("The text of Locks");
    expect(writing).toContain("1. concurrency.pdf, §2 Counters, pp. 2–30");
    const [lesson] = await t.db.select().from(lessons).where(eq(lessons.sessionId, sessionId));
    expect(lesson?.steps[0]?.body[0]).toMatchObject({
      type: "paragraph",
      children: [
        {
          type: "text",
          value: "The book says the value is copied out, changed, and put back (p. 30)",
        },
        {
          type: "cite",
          ref: 1,
          source: {
            url: `/api/tracks/${trackId}/files/${fileId}#page=2`,
            title: "concurrency.pdf, §2 Counters, pp. 2–30",
          },
        },
        { type: "text", value: "." },
      ],
    });

    // The coverage: taught, known, planned.
    const coverage = (await (
      await t.request(`/api/tracks/${trackId}/source`, { cookie })
    ).json()) as {
      sections: SourceSectionView[];
    };
    expect(coverage.sections.map((s) => [s.n, s.status])).toEqual([
      [1, "known"],
      [2, "taught"],
      [3, "planned"],
    ]);
    expect((await snapshot(cookie, sessionId)).state.phase).toBe("lesson");
  });
});
