import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { ProviderCallError } from "../engine/model-call.js";
import { pacedModel } from "./paced.js";
import { bookPdf, DOCX, epub, prose, text } from "../test/files.js";
import { extractSource, splitAtHeadings, textLayerUnusable, UnreadableSource } from "./extract.js";
import {
  LONG_CHAPTER_CHARACTERS,
  LONG_CHAPTER_PAGES,
  PASSAGE_MAX,
  PASSAGE_MIN,
  splitText,
  toChapters,
  type Divider,
} from "./chapters.js";
import { summaryBatches } from "./summarize.js";
import { batches, splitTranscript } from "./transcribe.js";

describe("taking a source's text out", () => {
  it("reads a PDF page by page, marks the scanned pages for the model, and finds its chapters", async () => {
    const bytes = await bookPdf({
      title: "Networks from the Ground Up",
      pages: [prose("the preface"), prose("packets"), "scan", prose("routing"), ""],
      chapters: [
        { title: "Packets", page: 2 },
        { title: "Routing", page: 4 },
      ],
    });
    const extracted = await extractSource("pdf", bytes);
    expect(extracted.form).toBe("paged");
    if (extracted.form !== "paged") return;
    expect(extracted.title).toBe("Networks from the Ground Up");
    expect(extracted.pages.map((p) => p.needsModel)).toEqual([false, false, true, false, false]);
    expect(extracted.pages[1]?.text).toContain("Sentence 1 about packets");
    expect(extracted.pages[1]?.label).toBe("2");
    expect(extracted.chapters).toEqual([
      { title: "Packets", part: null, page: 2, headings: [] },
      { title: "Routing", part: null, page: 4, headings: [] },
    ]);
  });

  it("reads an EPUB's chapters in its reading order", async () => {
    const bytes = epub("A Short History", [
      { title: "Beginnings", body: "The first paragraph.\n\nThe second." },
      { title: "Middles", body: "Then this happened." },
    ]);
    const extracted = await extractSource("epub", bytes);
    expect(extracted).toEqual({
      form: "flowing",
      title: "A Short History",
      chapters: [
        {
          title: "Beginnings",
          part: null,
          text: "# Beginnings\n\nThe first paragraph.\n\nThe second.",
        },
        { title: "Middles", part: null, text: "# Middles\n\nThen this happened." },
      ],
    });
  });

  it("reads a Word document and a text file, split at their headings", async () => {
    const word = await extractSource("docx", DOCX);
    expect(word.form === "flowing" && word.chapters[0]?.text).toContain("Ada Lovelace");
    const notes = await extractSource(
      "text",
      text("# Notes\n\nIntro.\n\n## One\n\nFirst.\n\n## Two\n\nSecond."),
    );
    // A heading above the repeated level opens a chapter too.
    expect(notes.form === "flowing" && notes.chapters.map((c) => c.title)).toEqual([
      "Notes",
      "One",
      "Two",
    ]);
  });

  it("refuses what isn't what it says it is", async () => {
    await expect(extractSource("epub", text("not a zip"))).rejects.toThrow(UnreadableSource);
    await expect(extractSource("pdf", text("%PDF-1.7 broken"))).rejects.toThrow(UnreadableSource);
    await expect(extractSource("text", Uint8Array.from([0xff, 0xfe, 0x00]))).rejects.toThrow(
      UnreadableSource,
    );
  });

  it("calls a text layer unusable when it is thin or garbled", () => {
    expect(textLayerUnusable("12")).toBe(true);
    expect(textLayerUnusable(prose("a subject"))).toBe(false);
    expect(textLayerUnusable("�".repeat(20) + "x".repeat(100))).toBe(true);
  });

  it("splits markdown at its highest repeated heading, and keeps a few top headings as the parts", () => {
    expect(splitAtHeadings("plain text only")).toEqual([
      { title: "", part: null, text: "plain text only" },
    ]);
    expect(splitAtHeadings("# A\n\nx\n\n# B\n\ny").map((c) => c.title)).toEqual(["A", "B"]);
    const parted = splitAtHeadings(
      "# Part I\n\n## One\n\nx\n\n## Two\n\ny\n\n# Part II\n\n## Three\n\nz",
    );
    expect(parted.map((c) => [c.title, c.part])).toEqual([
      ["One", "Part I"],
      ["Two", "Part I"],
      ["Three", "Part II"],
    ]);
  });
});

describe("a source's chapters", () => {
  const page = (n: number, words: string) => ({
    page: n,
    label: String(n),
    text: words,
    needsModel: false,
  });
  const noDivider: Divider = () => Promise.reject(new Error("not asked"));

  it("are the author's chapters, with the pages each spans, their part, and passages with a line where each page starts", async () => {
    const long = "x".repeat(PASSAGE_MIN);
    const { chapters } = await toChapters(
      {
        form: "paged",
        title: null,
        pages: [page(1, long), page(2, long), page(3, long), page(4, long)],
        chapters: [
          { title: "One", part: "Part I", page: 1 },
          { title: "Two", part: "Part I", page: 3 },
        ],
      },
      noDivider,
    );
    expect(chapters.map((c) => [c.title, c.part, c.pageStart, c.pages])).toEqual([
      ["One", "Part I", 1, "pp. 1–2"],
      ["Two", "Part I", 3, "pp. 3–4"],
    ]);
    expect(chapters[0]?.passages[0]?.text.startsWith("[p. 1]\n")).toBe(true);
    expect(chapters[0]?.characters).toBe(chapters[0]?.passages[0]?.text.length);
  });

  it("cut a chapter's text into passages of at most a prompt's share, and join a stretch too short to its neighbour", async () => {
    const pages = Array.from({ length: 6 }, (_, i) => page(i + 1, "y".repeat(PASSAGE_MAX / 2)));
    const { chapters } = await toChapters(
      {
        form: "paged",
        title: null,
        pages: [page(0, "Part One"), ...pages].map((p, i) => ({
          ...p,
          page: i + 1,
          label: String(i + 1),
        })),
        chapters: [{ title: "Long chapter", part: null, page: 2 }],
      },
      noDivider,
    );
    // The part title page joined the chapter; the chapter is one reading in six passages.
    expect(chapters.map((c) => [c.title, c.pages, c.passages.length])).toEqual([
      ["Long chapter", "pp. 1–7", 6],
    ]);
    for (const p of chapters[0]?.passages ?? [])
      expect(p.text.length).toBeLessThanOrEqual(PASSAGE_MAX + 20);
  });

  it("cut a chapter too long for a sitting at its own headings, never at a count of pages", async () => {
    const pages = Array.from({ length: LONG_CHAPTER_PAGES + 10 }, (_, i) =>
      page(i + 1, "z".repeat(PASSAGE_MIN)),
    );
    const { chapters, undivided } = await toChapters(
      {
        form: "paged",
        title: null,
        pages,
        chapters: [
          {
            title: "Routing",
            part: null,
            page: 1,
            headings: [
              { title: "Routing tables", page: 20 },
              { title: "Finding a path", page: 35 },
            ],
          },
        ],
      },
      noDivider,
    );
    expect(undivided).toBe(0);
    expect(chapters.map((c) => [c.title, c.pages])).toEqual([
      ["Routing", "pp. 1–19"],
      ["Routing: Routing tables", "pp. 20–34"],
      ["Routing: Finding a path", "pp. 35–50"],
    ]);
  });

  it("have the model divide a long chapter with no headings where its topics change, and count such chapters for the estimate", async () => {
    const pages = Array.from({ length: LONG_CHAPTER_PAGES + 10 }, (_, i) =>
      page(i + 1, "w".repeat(PASSAGE_MIN)),
    );
    const extracted = {
      form: "paged" as const,
      title: null,
      pages,
      chapters: [{ title: "Everything", part: null, page: 1 }],
    };
    const counted = await toChapters(extracted, null);
    expect(counted.undivided).toBe(
      pages.reduce((sum, p) => sum + `[p. ${p.label}]\n`.length + p.text.length, 0),
    );
    expect(counted.chapters.map((c) => c.title)).toEqual(["Everything"]);
    const asked: { title: string; units: number }[] = [];
    const divider: Divider = (chapter) => {
      asked.push({ title: chapter.title, units: chapter.units.length });
      return Promise.resolve([
        { at: 0, title: "Beginnings" },
        { at: 25, title: "Middles" },
        { at: 99, title: "Out of range" },
      ]);
    };
    const { chapters } = await toChapters(extracted, divider);
    expect(asked).toEqual([{ title: "Everything", units: 50 }]);
    expect(chapters.map((c) => [c.title, c.pages])).toEqual([
      ["Everything: Beginnings", "pp. 1–25"],
      ["Everything: Middles", "pp. 26–50"],
    ]);
  });

  it("cut long flowing text at the heading level below the chapter's own", async () => {
    const body = (topic: string) => Array.from({ length: 30 }, () => prose(topic, 20)).join("\n\n");
    const text = `# Networks\n\n${body("intro")}\n\n## Packets\n\n${body("packets")}\n\n## Routing\n\n${body("routing")}`;
    expect(text.length).toBeGreaterThan(LONG_CHAPTER_CHARACTERS);
    const { chapters } = await toChapters(
      { form: "flowing", title: null, chapters: [{ title: "Networks", part: null, text }] },
      noDivider,
    );
    expect(chapters.map((c) => c.title)).toEqual([
      "Networks",
      "Networks: Packets",
      "Networks: Routing",
    ]);
  });

  it("split flowing text between paragraphs", () => {
    const paragraphs = Array.from({ length: 10 }, () => "z".repeat(1000)).join("\n\n");
    const parts = splitText(paragraphs, 3500);
    expect(parts).toHaveLength(4);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(3500);
  });
});

describe("reading with the model", () => {
  it("waits out a provider limiting requests, then goes on; anything else stops it", async () => {
    const limited = new ProviderCallError("rate-limited", {
      code: "provider-failed",
      kind: "rate-limited",
      provider: "OpenAI",
    });
    const waits: number[] = [];
    const sleep = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    const reply = (text: string): LanguageModelV4GenerateResult => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    });
    let calls = 0;
    const flaky = new MockLanguageModelV4({
      doGenerate: () => {
        calls++;
        return calls < 3 ? Promise.reject(limited) : Promise.resolve(reply("done"));
      },
    });
    const { text } = await generateText({
      model: pacedModel(flaky, { waitMs: 7, sleep }),
      prompt: "x",
    });
    expect(text).toBe("done");
    expect(waits).toEqual([7, 7]);

    const stuck = new MockLanguageModelV4({ doGenerate: () => Promise.reject(limited) });
    await expect(
      generateText({ model: pacedModel(stuck, { waitMs: 7, waits: 2, sleep }), prompt: "x" }),
    ).rejects.toBe(limited);
    expect(waits).toHaveLength(4);

    const broken = new MockLanguageModelV4({ doGenerate: () => Promise.reject(new Error("no")) });
    await expect(
      generateText({ model: pacedModel(broken, { waitMs: 7, sleep }), prompt: "x" }),
    ).rejects.toThrow("no");
    expect(waits).toHaveLength(4);
  });

  it("transcribes consecutive pages together, a few at a time", () => {
    expect(batches([9, 1, 2, 3, 4, 5, 6, 8])).toEqual([[1, 2, 3, 4, 5], [6], [8, 9]]);
  });

  it("splits a transcription back into its pages", () => {
    const pages = splitTranscript("=== page 3 ===\n# Title\n\nText.\n=== page 4 ===\nMore.");
    expect([...pages]).toEqual([
      [3, "# Title\n\nText."],
      [4, "More."],
    ]);
  });

  it("summarizes chapters in batches that stay within a call's reading", () => {
    const chapters = [3000, 3000, 5000, 1000].map((n, i) => ({ n: i, text: "s".repeat(n) }));
    expect(summaryBatches(chapters, 6000).map((b) => b.map((s) => s.n))).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });
});
