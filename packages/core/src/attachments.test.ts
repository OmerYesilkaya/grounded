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
    expect(attachmentProblem("sheet.xlsx", 10)).toEqual({
      code: "attachment-kind",
      name: "sheet.xlsx",
    });
    expect(attachmentProblem("cv.pdf", 0)).toEqual({ code: "attachment-empty", name: "cv.pdf" });
    expect(attachmentProblem("photo.png", 6 * MB)).toEqual({
      code: "attachment-too-large",
      name: "photo.png",
      megabytes: 5,
    });
    expect(attachmentProblem("cv.pdf", 11 * MB)).toEqual({
      code: "attachment-too-large",
      name: "cv.pdf",
      megabytes: 10,
    });
  });

  it("refuses too many files, or too much together", () => {
    expect(attachmentsProblem([{ size: MB }, { size: MB }])).toBeNull();
    const many = Array.from({ length: ATTACHMENT_LIMITS.files + 1 }, () => ({ size: 1 }));
    expect(attachmentsProblem(many)).toEqual({ code: "attachments-too-many", max: 8 });
    expect(attachmentsProblem([{ size: 9 * MB }, { size: 9 * MB }, { size: 3 * MB }])).toEqual({
      code: "attachments-too-large",
      megabytes: 20,
    });
  });
});
