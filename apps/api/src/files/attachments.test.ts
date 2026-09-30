import { describe, expect, it } from "vitest";
import { DOCX, PNG, pdf, text } from "../test/files.js";
import { cleanName, readAttachments } from "./attachments.js";

const one = async (name: string, bytes: Uint8Array) => readAttachments([{ name, bytes }]);

describe("reading attachments", () => {
  it("reads each kind: images and PDFs as they are, text and Word documents as text", async () => {
    const result = await readAttachments([
      { name: "photo.png", bytes: PNG },
      { name: "cv.pdf", bytes: await pdf(2) },
      { name: "notes.md", bytes: text("\uFEFF# Notes\r\n\r\n\r\n\r\nRedis") },
      { name: "cv.docx", bytes: DOCX },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachments).toMatchObject([
      { name: "photo.png", kind: "image", mediaType: "image/png", pages: null, text: null },
      { name: "cv.pdf", kind: "pdf", mediaType: "application/pdf", pages: 2, text: null },
      {
        name: "notes.md",
        kind: "text",
        mediaType: "text/markdown",
        pages: null,
        text: "# Notes\n\nRedis",
      },
      {
        name: "cv.docx",
        kind: "docx",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        pages: null,
        text: "Ada Lovelace\n\nBackend engineer: Node.js, Postgres, Redis caching.",
      },
    ]);
  });

  it("goes by what is inside a file, not its name", async () => {
    expect(await one("photo.jpg", PNG)).toMatchObject({
      ok: true,
      attachments: [{ mediaType: "image/png" }],
    });
    expect(await one("photo.png", text("not an image"))).toEqual({
      ok: false,
      error: { code: "attachment-not-what-it-says", name: "photo.png" },
    });
    expect(await one("cv.pdf", PNG)).toMatchObject({ ok: false });
    expect(await one("cv.docx", PNG)).toMatchObject({ ok: false });
    expect(await one("notes.txt", Uint8Array.from([0xff, 0xfe, 0x00]))).toEqual({
      ok: false,
      error: { code: "attachment-not-utf8", name: "notes.txt" },
    });
  });

  it("refuses files with no text, too much text, or too many PDF pages", async () => {
    expect(await one("empty.txt", text("  \n "))).toEqual({
      ok: false,
      error: { code: "attachment-no-text", name: "empty.txt" },
    });
    expect(await one("book.txt", text("x".repeat(50_001)))).toEqual({
      ok: false,
      error: { code: "attachment-too-long", name: "book.txt", characters: 50_001, max: 50_000 },
    });
    const result = await readAttachments([
      { name: "a.pdf", bytes: await pdf(30) },
      { name: "b.pdf", bytes: await pdf(21) },
    ]);
    expect(result).toEqual({
      ok: false,
      error: { code: "attachments-pdf-pages", pages: 51, max: 50 },
    });
  });

  it("refuses a kind it doesn't take, and too many files", async () => {
    const refused = await one("sheet.xlsx", PNG);
    expect(refused.ok || refused.error).toEqual({ code: "attachment-kind", name: "sheet.xlsx" });
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `${String(i)}.png`, bytes: PNG }));
    expect(await readAttachments(many)).toEqual({
      ok: false,
      error: { code: "attachments-too-many", max: 8 },
    });
  });

  it("keeps a file's own name, without folders or control characters", () => {
    expect(cleanName("C:\\Users\\ada\\cv.pdf")).toBe("cv.pdf");
    expect(cleanName("../../etc/cv\u0000.pdf")).toBe("cv.pdf");
    const long = cleanName(`${"a".repeat(300)}.pdf`);
    expect(long).toHaveLength(200);
    expect(long.endsWith(".pdf")).toBe(true);
    expect(cleanName("  ")).toBe("file");
  });
});
