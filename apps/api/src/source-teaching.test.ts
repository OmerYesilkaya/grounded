import {
  eq,
  learningSessions,
  lessons,
  sourceChapters,
  sourcePassages,
  tracks,
  users,
} from "@grounded/db";
import { beforeEach, describe, expect, it } from "vitest";
import { SURVEYING } from "./engine/source-tasks.js";
import { createTrack } from "./files/track-files.js";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";
import {
  createFlows,
  FIRST_QUESTION,
  homework,
  PLAN_ACTIONS,
  PLAN_TEXT,
  PROBE_SUMMARY,
  storedMessages,
} from "./test/flows.js";
import { bookPdf, prose } from "./test/files.js";
import type { SourceProgress } from "./track-source.js";

/*
 * A track taught from its source a chapter at a time (design §4.6): the session is about the
 * chapter the learner was asked to read, the probe asks about it with its text in the prompt and
 * hears how far they read, the lesson teaches only its gaps from its passages and cites them, a
 * chapter that held gets no lesson, and the close assigns the next chapter.
 */

const models = scriptedModels();
const t = createTestHarness({ models: models.access });
const { snapshot, until, putOffHomework } = createFlows(t, models);

beforeEach(() => {
  models.reset();
});

const CHAPTERS = [
  { title: "Opening pages", pages: "p. 1", pageStart: 1, summary: "The preface.", assumes: "" },
  {
    title: "Counters",
    pages: "pp. 2–30",
    pageStart: 2,
    summary: "How a counter is copied, changed and put back.",
    assumes: "What a variable is.",
  },
  {
    title: "Locks",
    pages: "pp. 31–60",
    pageStart: 31,
    summary: "How a lock keeps two writers apart.",
    assumes: "",
  },
];

/**
 * A learner with a track whose source is read: three chapters of a PDF, the first read and the
 * second assigned.
 */
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
      source: {
        ...SURVEYING,
        status: "ready",
        pages: 60,
        chapters: 3,
        summarized: 3,
        assigned: 2,
        readThrough: 1,
      },
    },
    [{ name: "concurrency.pdf", kind: "pdf", mediaType: "application/pdf", bytes, pages: 60 }],
    "source",
  );
  const [file] = await t.db.query.trackFiles.findMany({
    where: (f, { eq: is }) => is(f.trackId, track.id),
  });
  if (!file) throw new Error("no file");
  for (const [i, c] of CHAPTERS.entries()) {
    const text = `[p. ${String(c.pageStart)}]\nThe text of ${c.title}: a value is copied out, changed and put back.`;
    const [chapter] = await t.db
      .insert(sourceChapters)
      .values({
        trackId: track.id,
        fileId: file.id,
        n: i + 1,
        title: c.title,
        part: null,
        pageStart: c.pageStart,
        pages: c.pages,
        characters: text.length,
        summary: c.summary,
        assumes: c.assumes,
      })
      .returning();
    if (!chapter) throw new Error("no chapter");
    await t.db.insert(sourcePassages).values({
      trackId: track.id,
      chapterId: chapter.id,
      n: i + 1,
      pageStart: c.pageStart,
      pages: c.pages,
      text,
    });
  }
  return { cookie, trackId: track.id, fileId: file.id };
};

const progress = async (cookie: string, trackId: string) =>
  (await (await t.request(`/api/tracks/${trackId}/source`, { cookie })).json()) as SourceProgress;

const source = async (trackId: string) => {
  const [row] = await t.db
    .select({ source: tracks.source })
    .from(tracks)
    .where(eq(tracks.id, trackId));
  return row?.source;
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

describe("teaching a track from its source, a chapter at a time", () => {
  it("probes on the chapter the learner was asked to read, hears they read further, and teaches the gaps from the chapters' text", async () => {
    const { cookie, trackId, fileId } = await sourceTrack();
    models.enableSearch();

    // The session is about the assigned chapter; the probe opens on it, with its text in the prompt.
    models.script("probe", { text: FIRST_QUESTION });
    const started = await t.request(`/api/tracks/${trackId}/sessions`, { method: "POST", cookie });
    const { id: sessionId } = (await started.json()) as { id: string };
    await until(cookie, sessionId, storedMessages(1));
    const [session] = await t.db
      .select()
      .from(learningSessions)
      .where(eq(learningSessions.id, sessionId));
    expect(session?.sourceChapters).toEqual([2]);
    const probe = JSON.stringify(
      models.used.find((u) => u.purpose === "probe")?.model.doStreamCalls[0]?.prompt,
    );
    expect(probe).toContain("## The source");
    expect(probe).toContain(
      "- Chapter 2 Counters (pp. 2–30): How a counter is copied, changed and put back. Expects the reader to know: What a variable is.",
    );
    expect(probe).toContain("- They have finished reading through Chapter 1.");
    expect(probe).toContain("- Asked to read next: Chapter 2.");
    expect(probe).toContain("- This session is about Chapter 2:");
    expect(probe).toContain("## Tracks taught from a source");
    expect(probe).toContain("## The chapter the learner was asked to read");
    expect(probe).toContain("The text of Counters: a value is copied out");
    expect(probe).not.toContain("The text of Locks");
    expect(probe).toContain(
      "Before this session they were asked to read Chapter 2, Counters, pp. 2–30; open by asking how far they got. Why they are reading it, in their words: My course's set text",
    );

    // The learner read on into chapter 3: the session takes it in, and the probe asks about both.
    models.script("probe-decision", {
      thenGenerate: [JSON.stringify({ actions: [], finished: true, readThrough: 3 })],
    });
    models.script("probe-summary", { text: PROBE_SUMMARY });
    models.script(
      "plan",
      { searches: ["binary numbers"], text: "NOTES: groundwork." },
      {
        text: PLAN_TEXT,
        thenGenerate: [JSON.stringify({ actions: PLAN_ACTIONS, lessonNeeded: true })],
      },
    );
    await t.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ text: "I read chapters 2 and 3" }),
    });
    await until(cookie, sessionId, (s) => s.state.plan === "proposed");
    expect(await source(trackId)).toMatchObject({ assigned: 2, readThrough: 3 });
    const [taken] = await t.db
      .select()
      .from(learningSessions)
      .where(eq(learningSessions.id, sessionId));
    expect(taken?.sourceChapters).toEqual([2, 3]);
    expect(taken?.lessonNeeded).toBe(true);
    const summary = JSON.stringify(
      models.used.find((u) => u.purpose === "probe-summary")?.model.doGenerateCalls[0]?.prompt,
    );
    expect(summary).toContain("how far the learner has read");
    expect(summary).toContain("This session is about Chapters 2–3");
    // The plan's research covers only the groundwork the source assumes.
    const [researcher] = models.used.filter((u) => u.purpose === "plan").map((u) => u.model);
    expect(JSON.stringify(researcher?.doStreamCalls[0]?.prompt)).toContain(
      "check with web search only the groundwork the learner lacks that the source assumes",
    );

    // The lesson: both chapters' text instead of web research, cited as the source's chapters.
    models.script("lesson", { text: STEP, thenGenerate: [JSON.stringify(OUTLINE)] });
    await t.request(`/api/sessions/${sessionId}/approve-plan`, { method: "POST", cookie });
    await until(cookie, sessionId, (s) => s.lesson?.steps.length === 1);
    const lessonCalls = models.used.filter((u) => u.purpose === "lesson");
    expect(lessonCalls).toHaveLength(1);
    const writing = JSON.stringify(lessonCalls[0]?.model.doStreamCalls[0]?.prompt);
    expect(writing).toContain("The text of Chapters 2–3, which the learner was asked to read");
    expect(writing).toContain("The text of Counters: a value is copied out");
    expect(writing).toContain("The text of Locks");
    expect(writing).not.toContain("The text of Opening pages");
    expect(writing).toContain("1. concurrency.pdf, Chapter 2 Counters, pp. 2–30");
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
            title: "concurrency.pdf, Chapter 2 Counters, pp. 2–30",
          },
        },
        { type: "text", value: "." },
      ],
    });

    // The reading: chapter 1 read, chapters 2 and 3 taught.
    const shown = await progress(cookie, trackId);
    expect(shown.chapters.map((c) => [c.n, c.status])).toEqual([
      [1, "read"],
      [2, "taught"],
      [3, "taught"],
    ]);
    expect((await snapshot(cookie, sessionId)).state.phase).toBe("lesson");
  });

  it("teaches no lesson when the chapter held, sets homework on it, and assigns the next chapter at the close", async () => {
    const { cookie, trackId } = await sourceTrack();
    models.script("probe", { text: FIRST_QUESTION });
    const started = await t.request(`/api/tracks/${trackId}/sessions`, { method: "POST", cookie });
    const { id: sessionId } = (await started.json()) as { id: string };
    await until(cookie, sessionId, storedMessages(1));

    // The probe finds the chapter held; the plan teaches nothing this session.
    models.script("probe-decision", {
      thenGenerate: [JSON.stringify({ actions: [], finished: true, readThrough: 2 })],
    });
    models.script("probe-summary", { text: "Everything in chapter 2 held." });
    models.script("plan", {
      text: "Chapter 2 held: no lesson today, homework to show it holds, then on to chapter 3.",
      thenGenerate: [JSON.stringify({ actions: PLAN_ACTIONS, lessonNeeded: false })],
    });
    await t.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ text: "I finished chapter 2" }),
    });
    await until(cookie, sessionId, (s) => s.state.plan === "proposed");

    // Approving the plan goes to the homework, whose request says there was no lesson.
    models.script("homework", homework("Explain to a friend why a counter can lose an update."));
    const approved = await t.request(`/api/sessions/${sessionId}/approve-plan`, {
      method: "POST",
      cookie,
    });
    expect(await approved.json()).toMatchObject({
      state: { phase: "homework", homework: "writing", lesson: { status: "none" } },
    });
    await until(cookie, sessionId, (s) => s.state.homework === "assigned");
    const asked = JSON.stringify(
      models.used.find((u) => u.purpose === "homework")?.model.doStreamCalls[0]?.prompt,
    );
    expect(asked).toContain("there was no lesson this session");
    expect(models.used.filter((u) => u.purpose === "lesson")).toHaveLength(0);

    // The close assigns chapter 3, and the recap is told to name it.
    models.script("close", { text: "Chapter 2 held. Next: read Chapter 3, Locks, pp. 31–60." });
    models.script("term-sweep", { thenGenerate: [JSON.stringify({ actions: [] })] });
    models.script("left-off", { text: "Next: chapter 3." });
    await putOffHomework(cookie, sessionId);
    await until(cookie, sessionId, (s) => s.state.phase === "closed");
    const recap = JSON.stringify(
      models.used.find((u) => u.purpose === "close")?.model.doStreamCalls[0]?.prompt,
    );
    expect(recap).toContain("## The next reading");
    expect(recap).toContain(
      "The app has assigned Chapter 3, Locks, pp. 31–60 to read before the next session. Name it in the recap, as the next reading.",
    );
    expect(await source(trackId)).toMatchObject({ assigned: 3, readThrough: 2 });
    const shown = await progress(cookie, trackId);
    expect(shown.chapters.map((c) => [c.n, c.status])).toEqual([
      [1, "read"],
      [2, "held"],
      [3, "assigned"],
    ]);
    expect(shown.next).toMatchObject({ n: 3, title: "Locks", pages: "pp. 31–60", first: false });

    // The track list carries the next reading too.
    const list = (await (await t.request("/api/tracks", { cookie })).json()) as {
      reading: { n: number } | null;
    }[];
    expect(list[0]?.reading).toMatchObject({ n: 3 });
  });

  it("keeps the chapter assigned when the learner didn't finish it", async () => {
    const { cookie, trackId } = await sourceTrack();
    models.script("probe", { text: FIRST_QUESTION });
    const started = await t.request(`/api/tracks/${trackId}/sessions`, { method: "POST", cookie });
    const { id: sessionId } = (await started.json()) as { id: string };
    await until(cookie, sessionId, storedMessages(1));
    models.script("probe-decision", {
      thenGenerate: [JSON.stringify({ actions: [], finished: true, readThrough: null })],
    });
    models.script("probe-summary", { text: "Half of chapter 2 read; what was read held." });
    models.script("plan", {
      text: "Nothing to teach yet; finish chapter 2.",
      thenGenerate: [JSON.stringify({ actions: PLAN_ACTIONS, lessonNeeded: false })],
    });
    await t.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ text: "I got halfway through chapter 2" }),
    });
    await until(cookie, sessionId, (s) => s.state.plan === "proposed");
    models.script("homework", homework("Explain what you read so far."));
    await t.request(`/api/sessions/${sessionId}/approve-plan`, { method: "POST", cookie });
    models.script("close", { text: "Finish chapter 2 before next time." });
    models.script("term-sweep", { thenGenerate: [JSON.stringify({ actions: [] })] });
    models.script("left-off", { text: "Chapter 2 half read." });
    await putOffHomework(cookie, sessionId);
    await until(cookie, sessionId, (s) => s.state.phase === "closed");
    const recap = JSON.stringify(
      models.used.find((u) => u.purpose === "close")?.model.doStreamCalls[0]?.prompt,
    );
    expect(recap).toContain(
      "The learner hasn't finished Chapter 2, Counters, pp. 2–30, so it stays assigned",
    );
    expect(recap).toContain("It expects the reader to know: What a variable is.");
    expect(await source(trackId)).toMatchObject({ assigned: 2, readThrough: 1 });
  });
});
