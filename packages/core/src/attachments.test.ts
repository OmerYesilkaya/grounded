import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_LIMITS,
  attachmentKind,
  attachmentProblem,
  attachmentsProblem,
} from "./attachments.js";

const MB = 1024 * 1024;

describe("attachments", () => {
  it("knows a file's kind by its extension, in any case", () => {
    expect(attachmentKind("CV.PDF")).toEqual({ kind: "pdf", mediaType: "application/pdf" });
    expect(attachmentKind("page.jpeg")?.mediaType).toBe("image/jpeg");
    expect(attachmentKind("notes.md")?.kind).toBe("text");
    expect(attachmentKind("letter.docx")?.kind).toBe("docx");
    expect(attachmentKind("sheet.xlsx")).toBeNull();
    expect(attachmentKind("README")).toBeNull();
    expect(attachmentKind("x.constructor")).toBeNull();
    expect(ATTACHMENT_ACCEPT).toContain(".pdf");
  });

  it("refuses a kind it doesn't take, an empty file and one too large", () => {
    expect(attachmentProblem("cv.pdf", 2 * MB)).toBeNull();
    expect(attachmentProblem("sheet.xlsx", 10)).toMatch(/only images, PDFs/);
    expect(attachmentProblem("cv.pdf", 0)).toBe("cv.pdf is empty.");
    expect(attachmentProblem("photo.png", 6 * MB)).toBe("photo.png is larger than 5 MB.");
    expect(attachmentProblem("cv.pdf", 11 * MB)).toBe("cv.pdf is larger than 10 MB.");
  });

  it("refuses too many files, or too much together", () => {
    expect(attachmentsProblem([{ size: MB }, { size: MB }])).toBeNull();
    const many = Array.from({ length: ATTACHMENT_LIMITS.files + 1 }, () => ({ size: 1 }));
    expect(attachmentsProblem(many)).toBe("Attach at most 8 files.");
    expect(attachmentsProblem([{ size: 9 * MB }, { size: 9 * MB }, { size: 3 * MB }])).toBe(
      "The files come to more than 20 MB together.",
    );
  });
});
