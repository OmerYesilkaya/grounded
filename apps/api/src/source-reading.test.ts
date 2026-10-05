import type { SourceReading } from "@grounded/core";
import {
  asc,
  credentials,
  eq,
  sourceChapters,
  sourcePassages,
  trackFiles,
  tracks,
  users,
} from "@grounded/db";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";
import { bookPdf, epub, prose, text } from "./test/files.js";
import type { SourceProgress } from "./track-source.js";

/*
 * A track taught from a source (design §4.6): reading it, from the upload through the estimate the
 * learner agrees to, to the chapters the learner reads and the passages the track is taught from.
 */

const models = scriptedModels();
const t = createTestHarness({ models: models.access });

beforeEach(() => {
  models.reset();
});

interface Created {
  id: string;
  title: string;
}

const form = (notes: string, files: { name: string; bytes: Uint8Array }[]) => {
  const body = new FormData();
  body.set("goal", notes);
  for (const f of files) body.append("files", new File([f.bytes.slice()], f.name));
  return body;
};

/** A learner with a key for a provider whose cheap model reads PDFs (or, with DeepSeek, doesn't). */
const learner = async (provider: "anthropic" | "deepseek" = "anthropic") => {
  const cookie = await t.signIn("ada@example.com");
  const [user] = await t.db.select().from(users).where(eq(users.email, "ada@example.com"));
  if (!user) throw new Error("no user");
  await t.db.insert(credentials).values({
    userId: user.id,
    provider,
    model: provider === "anthropic" ? "claude-opus-5-5" : "deepseek-v4-pro",
    sealedKey: t.vault.seal("sk-test-0000", user.id),
    keyHint: "0000",
  });
  return cookie;
};

const create = async (cookie: string, body: FormData) => {
  const response = await t.request("/api/tracks?from=source", { method: "POST", cookie, body });
  return {
    status: response.status,
    body: (await response.json()) as Created & { error?: unknown },
  };
};

const reading = async (trackId: string): Promise<SourceReading | null> => {
  const [row] = await t.db
    .select({ source: tracks.source })
    .from(tracks)
    .where(eq(tracks.id, trackId));
  return row?.source ?? null;
};

const until = (trackId: string, status: SourceReading["status"]) =>
  t.waitFor(async () => (await reading(trackId))?.status === status);

const read = (cookie: string, trackId: string) =>
  t.request(`/api/tracks/${trackId}/source/read`, { method: "POST", cookie });

const progress = async (cookie: string, trackId: string) =>
  (await (await t.request(`/api/tracks/${trackId}/source`, { cookie })).json()) as SourceProgress;

const summaries = (n: number) =>
  JSON.stringify({
    summaries: Array.from({ length: n }, (_, i) => ({
      n: i + 1,
      summary: `Chapter ${String(i + 1)}.`,
      assumes: "",
      kind: "text",
    })),
  });

/** A full page of text; two of them are more than a sitting's minimum, so a chapter of their own. */
const pageOf = (topic: string) =>
  Array.from(
    { length: 80 },
    (_, i) =>
      `Sentence ${String(i + 1)} about ${topic}, written out at a length that fills the line and then some, as a book's page does.`,
  ).join("\n");

const BOOK = {
  title: "Networks from the Ground Up",
  pages: [
    pageOf("the preface"),
    pageOf("the contents"),
    pageOf("packets"),
    pageOf("headers"),
    "scan",
    pageOf("routing"),
    pageOf("routes"),
  ],
  chapters: [
    { title: "Packets", page: 3 },
    { title: "Routing", page: 6 },
  ],
};

describe("a track from a source", () => {
  it("is read once the learner has seen the estimate: scanned pages by the model, then chapters with their passages and summaries, and the first chapter assigned", async () => {
    const cookie = await learner();
    const created = await create(
      cookie,
      form("For my networking course", [{ name: "networks.pdf", bytes: await bookPdf(BOOK) }]),
    );
    expect(created.status).toBe(201);
    const trackId = created.body.id;
    const [file] = await t.db.select().from(trackFiles).where(eq(trackFiles.trackId, trackId));
    expect(file).toMatchObject({ role: "source", kind: "pdf", pages: 7 });

    // The survey counts, with no model, and the book's own title names the track.
    await until(trackId, "awaiting");
    const surveyed = await reading(trackId);
    expect(surveyed).toMatchObject({ status: "awaiting", pages: 7, transcribe: 1, chapters: 3 });
    expect(surveyed?.estimate).toBeGreaterThan(0);
    expect(models.used).toEqual([]);
    const [named] = await t.db.select().from(tracks).where(eq(tracks.id, trackId));
    expect(named).toMatchObject({
      title: "Networks from the Ground Up",
      goal: "For my networking course",
    });

    // No session until it is read.
    const early = await t.request(`/api/tracks/${trackId}/sessions`, {
      method: "POST",
      cookie,
      body: "{}",
    });
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ error: { code: "source-not-ready" } });

    models.script("source-transcribe", {
      text: "=== page 5 ===\n# A diagram page\n\nA scanned page about packets crossing a router.",
    });
    models.script("source-summary", {
      text: JSON.stringify({
        summaries: [
          { n: 1, summary: "The title page and the contents.", assumes: "", kind: "apparatus" },
          { n: 2, summary: "What a packet is.", assumes: "Binary numbers.", kind: "text" },
          { n: 3, summary: "How routing finds a path.", assumes: "", kind: "text" },
        ],
      }),
    });
    expect((await read(cookie, trackId)).status).toBe(202);
    // Said twice, it reads once.
    expect((await read(cookie, trackId)).status).toBe(409);
    await until(trackId, "ready");

    const transcribing = models.used.find((u) => u.purpose === "source-transcribe")?.model;
    const sent = JSON.stringify(transcribing?.doGenerateCalls[0]?.prompt);
    expect(sent).toContain("application/pdf");
    expect(sent).toContain("pages 5 of the source");
    const summarizing = models.used.find((u) => u.purpose === "source-summary")?.model;
    expect(JSON.stringify(summarizing?.doGenerateCalls[0]?.prompt)).toContain(
      "## Chapter 2: Packets",
    );

    const chapters = await t.db
      .select()
      .from(sourceChapters)
      .where(eq(sourceChapters.trackId, trackId))
      .orderBy(asc(sourceChapters.n));
    expect(chapters.map((c) => [c.n, c.title, c.pages, c.summary, c.assumes, c.kind])).toEqual([
      [1, "Opening pages", "pp. 1–2", "The title page and the contents.", "", "apparatus"],
      [2, "Packets", "pp. 3–5", "What a packet is.", "Binary numbers.", "text"],
      [3, "Routing", "pp. 6–7", "How routing finds a path.", "", "text"],
    ]);
    const passages = await t.db
      .select()
      .from(sourcePassages)
      .where(eq(sourcePassages.trackId, trackId))
      .orderBy(asc(sourcePassages.n));
    expect(passages.map((p) => [p.n, p.chapterId, p.pages])).toEqual([
      [1, chapters[0]?.id, "pp. 1–2"],
      [2, chapters[1]?.id, "pp. 3–5"],
      [3, chapters[2]?.id, "pp. 6–7"],
    ]);
    expect(passages[1]?.text).toContain("[p. 5]\n# A diagram page");
    expect(chapters[1]?.characters).toBe(passages[1]?.text.length);
    expect(await reading(trackId)).toMatchObject({
      status: "ready",
      transcribed: 1,
      chapters: 3,
      summarized: 3,
      assigned: 2,
      readThrough: 0,
    });

    // The first chapter of the book's text is the one to read first; the title page is never
    // assigned; the rest lie ahead.
    const shown = await progress(cookie, trackId);
    expect(shown.chapters.map((c) => [c.n, c.source, c.status])).toEqual([
      [1, "networks.pdf", "skipped"],
      [2, "networks.pdf", "assigned"],
      [3, "networks.pdf", "ahead"],
    ]);
    expect(shown.next).toMatchObject({
      n: 2,
      source: "networks.pdf",
      title: "Packets",
      pages: "pp. 3–5",
      assumes: "Binary numbers.",
      first: true,
    });
  });

  it("keeps what was read when reading stops, and goes on from there when asked again", async () => {
    const cookie = await learner();
    const created = await create(
      cookie,
      form("", [{ name: "networks.pdf", bytes: await bookPdf(BOOK) }]),
    );
    const trackId = created.body.id;
    await until(trackId, "awaiting");
    models.script("source-transcribe", { text: "=== page 5 ===\nThe scanned page." });
    // The summary call fails: no script for it.
    expect((await read(cookie, trackId)).status).toBe(202);
    await until(trackId, "failed");
    expect(await reading(trackId)).toMatchObject({
      failure: { code: "source-reading-stopped", cause: { code: "our-side" } },
    });

    models.script("source-summary", { text: summaries(3) });
    expect((await read(cookie, trackId)).status).toBe(202);
    await until(trackId, "ready");
    // The page was transcribed once.
    expect(models.used.filter((u) => u.purpose === "source-transcribe")).toHaveLength(1);
  });

  it("can't be read by a model that doesn't read PDFs when a page needs it", async () => {
    const cookie = await learner("deepseek");
    const created = await create(
      cookie,
      form("", [{ name: "networks.pdf", bytes: await bookPdf(BOOK) }]),
    );
    await until(created.body.id, "failed");
    expect(await reading(created.body.id)).toMatchObject({
      failure: { code: "source-needs-vision", pages: 1, model: "DeepSeek Flash" },
    });
  });

  it("reads an EPUB and a text file with no model calls but the summaries, numbering chapters across them", async () => {
    const cookie = await learner();
    const long = (topic: string) => Array.from({ length: 70 }, () => prose(topic, 2)).join("\n\n");
    const created = await create(
      cookie,
      form("", [
        {
          name: "history.epub",
          bytes: epub("A Short History", [
            { title: "Beginnings", body: long("beginnings") },
            { title: "Middles", body: long("middles") },
          ]),
        },
        { name: "notes.md", bytes: text(`# One\n\n${long("one")}\n\n# Two\n\n${long("two")}`) },
      ]),
    );
    const trackId = created.body.id;
    await until(trackId, "awaiting");
    expect(await reading(trackId)).toMatchObject({ pages: 0, transcribe: 0, chapters: 4 });
    models.script("source-summary", { text: summaries(4) });
    await read(cookie, trackId);
    await until(trackId, "ready");
    const chapters = await t.db
      .select({ n: sourceChapters.n, title: sourceChapters.title, pages: sourceChapters.pages })
      .from(sourceChapters)
      .where(eq(sourceChapters.trackId, trackId))
      .orderBy(asc(sourceChapters.n));
    expect(chapters).toEqual([
      { n: 1, title: "Beginnings", pages: null },
      { n: 2, title: "Middles", pages: null },
      { n: 3, title: "One", pages: null },
      { n: 4, title: "Two", pages: null },
    ]);
    expect((await progress(cookie, trackId)).next).toMatchObject({
      n: 1,
      source: "history.epub",
      pages: null,
    });
  });

  it("refuses what can't be a source", async () => {
    const cookie = await learner();
    const none = await create(cookie, form("notes", []));
    expect(none.body.error).toEqual({ code: "source-required" });
    const picture = await create(cookie, form("", [{ name: "page.png", bytes: text("x") }]));
    expect(picture.body.error).toEqual({ code: "source-kind", name: "page.png" });
    const fake = await create(cookie, form("", [{ name: "book.epub", bytes: text("not a zip") }]));
    expect(fake.body.error).toEqual({ code: "attachment-not-what-it-says", name: "book.epub" });
  });
});
