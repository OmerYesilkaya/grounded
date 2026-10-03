import type { SourceReading, SourceSectionView } from "@grounded/core";
import { asc, credentials, eq, sourceSections, trackFiles, tracks, users } from "@grounded/db";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "./test/harness.js";
import { scriptedModels } from "./test/scripted-models.js";
import { bookPdf, epub, prose, text } from "./test/files.js";

/*
 * A track taught from a source (design §4.6): reading it, from the upload through the estimate the
 * learner agrees to, to the sections the track is taught from.
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

const BOOK = {
  title: "Networks from the Ground Up",
  pages: [
    prose("the preface", 30),
    prose("packets", 30),
    "scan",
    prose("routing", 30),
    prose("routes", 30),
  ],
  chapters: [
    { title: "Packets", page: 2 },
    { title: "Routing", page: 4 },
  ],
};

describe("a track from a source", () => {
  it("is read once the learner has seen the estimate: scanned pages by the model, then sections and their summaries", async () => {
    const cookie = await learner();
    const created = await create(
      cookie,
      form("For my networking course", [{ name: "networks.pdf", bytes: await bookPdf(BOOK) }]),
    );
    expect(created.status).toBe(201);
    const trackId = created.body.id;
    const [file] = await t.db.select().from(trackFiles).where(eq(trackFiles.trackId, trackId));
    expect(file).toMatchObject({ role: "source", kind: "pdf", pages: 5 });

    // The survey counts, with no model, and the book's own title names the track.
    await until(trackId, "awaiting");
    const surveyed = await reading(trackId);
    expect(surveyed).toMatchObject({ status: "awaiting", pages: 5, transcribe: 1 });
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
      text: "=== page 3 ===\n# A diagram page\n\nA scanned page about packets crossing a router.",
    });
    models.script("source-summary", {
      text: JSON.stringify({
        summaries: [
          { n: 1, summary: "The preface." },
          { n: 2, summary: "What a packet is." },
          { n: 3, summary: "How routing finds a path." },
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
    expect(sent).toContain("pages 3 of the source");

    const sections = await t.db
      .select()
      .from(sourceSections)
      .where(eq(sourceSections.trackId, trackId))
      .orderBy(asc(sourceSections.n));
    expect(sections.map((s) => [s.n, s.title, s.pages, s.summary])).toEqual([
      [1, "Opening pages", "p. 1", "The preface."],
      [2, "Packets", "pp. 2–3", "What a packet is."],
      [3, "Routing", "pp. 4–5", "How routing finds a path."],
    ]);
    expect(sections[1]?.text).toContain("[p. 3]\n# A diagram page");
    expect(await reading(trackId)).toMatchObject({
      status: "ready",
      transcribed: 1,
      sections: 3,
      summarized: 3,
    });

    const coverage = (await (
      await t.request(`/api/tracks/${trackId}/source`, { cookie })
    ).json()) as {
      sections: SourceSectionView[];
    };
    expect(coverage.sections.map((s) => [s.n, s.source, s.status])).toEqual([
      [1, "networks.pdf", "ahead"],
      [2, "networks.pdf", "ahead"],
      [3, "networks.pdf", "ahead"],
    ]);
  });

  it("keeps what was read when reading stops, and goes on from there when asked again", async () => {
    const cookie = await learner();
    const created = await create(
      cookie,
      form("", [{ name: "networks.pdf", bytes: await bookPdf(BOOK) }]),
    );
    const trackId = created.body.id;
    await until(trackId, "awaiting");
    models.script("source-transcribe", { text: "=== page 3 ===\nThe scanned page." });
    // The summary call fails: no script for it.
    expect((await read(cookie, trackId)).status).toBe(202);
    await until(trackId, "failed");
    expect(await reading(trackId)).toMatchObject({
      failure: { code: "source-reading-stopped", cause: { code: "our-side" } },
    });

    models.script("source-summary", {
      text: JSON.stringify({
        summaries: [1, 2, 3].map((n) => ({ n, summary: `Section ${String(n)}.` })),
      }),
    });
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

  it("reads an EPUB and a text file with no model calls but the summaries, numbering sections across them", async () => {
    const cookie = await learner();
    const long = (topic: string) => Array.from({ length: 20 }, () => prose(topic, 2)).join("\n\n");
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
    expect(await reading(trackId)).toMatchObject({ pages: 0, transcribe: 0 });
    models.script("source-summary", {
      text: JSON.stringify({
        summaries: [1, 2, 3, 4].map((n) => ({ n, summary: `Section ${String(n)}.` })),
      }),
    });
    await read(cookie, trackId);
    await until(trackId, "ready");
    const sections = await t.db
      .select({ n: sourceSections.n, title: sourceSections.title, pages: sourceSections.pages })
      .from(sourceSections)
      .where(eq(sourceSections.trackId, trackId))
      .orderBy(asc(sourceSections.n));
    expect(sections).toEqual([
      { n: 1, title: "Beginnings", pages: null },
      { n: 2, title: "Middles", pages: null },
      { n: 3, title: "One", pages: null },
      { n: 4, title: "Two", pages: null },
    ]);
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
