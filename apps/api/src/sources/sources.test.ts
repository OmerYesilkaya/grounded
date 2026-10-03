import { describe, expect, it } from "vitest";
import { bookPdf, DOCX, epub, prose, text } from "../test/files.js";
import { extractSource, splitAtHeadings, textLayerUnusable, UnreadableSource } from "./extract.js";
import { SECTION_MAX, SECTION_MIN, splitText, toSections } from "./sections.js";
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
      { title: "Packets", page: 2 },
      { title: "Routing", page: 4 },
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
        { title: "Beginnings", text: "# Beginnings\n\nThe first paragraph.\n\nThe second." },
        { title: "Middles", text: "# Middles\n\nThen this happened." },
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

  it("splits markdown at its highest repeated heading", () => {
    expect(splitAtHeadings("plain text only")).toEqual([{ title: "", text: "plain text only" }]);
    expect(splitAtHeadings("# A\n\nx\n\n# B\n\ny").map((c) => c.title)).toEqual(["A", "B"]);
  });
});

describe("a source's sections", () => {
  const page = (n: number, words: string) => ({
    page: n,
    label: String(n),
    text: words,
    needsModel: false,
  });

  it("are its chapters, with the pages each spans and a line where each page starts", () => {
    const long = "x".repeat(SECTION_MIN);
    const sections = toSections({
      form: "paged",
      title: null,
      pages: [page(1, long), page(2, long), page(3, long), page(4, long)],
      chapters: [
        { title: "One", page: 1 },
        { title: "Two", page: 3 },
      ],
    });
    expect(sections.map((s) => [s.title, s.pageStart, s.pages])).toEqual([
      ["One", 1, "pp. 1–2"],
      ["Two", 3, "pp. 3–4"],
    ]);
    expect(sections[0]?.text.startsWith("[p. 1]\n")).toBe(true);
  });

  it("split a chapter too long for a lesson into parts, and join one too short to its neighbour", () => {
    const pages = Array.from({ length: 6 }, (_, i) => page(i + 1, "y".repeat(SECTION_MAX / 2)));
    const sections = toSections({
      form: "paged",
      title: null,
      pages: [page(0, "Part One"), ...pages].map((p, i) => ({
        ...p,
        page: i + 1,
        label: String(i + 1),
      })),
      chapters: [{ title: "Long chapter", page: 2 }],
    });
    expect(sections.map((s) => s.title)).toEqual([
      "Long chapter (part 1 of 6)",
      "Long chapter (part 2 of 6)",
      "Long chapter (part 3 of 6)",
      "Long chapter (part 4 of 6)",
      "Long chapter (part 5 of 6)",
      "Long chapter (part 6 of 6)",
    ]);
    // The part title page joined the chapter's first part.
    expect(sections[0]?.pages).toBe("pp. 1–2");
    for (const s of sections) expect(s.text.length).toBeLessThanOrEqual(SECTION_MAX + 20);
  });

  it("split flowing text between paragraphs", () => {
    const paragraphs = Array.from({ length: 10 }, () => "z".repeat(1000)).join("\n\n");
    const parts = splitText(paragraphs, 3500);
    expect(parts).toHaveLength(4);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(3500);
  });
});

describe("reading with the model", () => {
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

  it("summarizes sections in batches that stay within a call's reading", () => {
    const sections = [3000, 3000, 5000, 1000].map((n, i) => ({ n: i, text: "s".repeat(n) }));
    expect(summaryBatches(sections, 6000).map((b) => b.map((s) => s.n))).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });
});
