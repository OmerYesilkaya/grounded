import { describe, expect, it } from "vitest";
import { messagesFor } from "@/i18n";
import { formatsFor } from "@/i18n/format";
import { formatSize, reasonOnly } from "./attachment-chip";
import { type RefusalNotice } from "@grounded/core/notices";

const en = messagesFor("en").session;
const tr = messagesFor("tr").session;

describe("attachment chips", () => {
  it("say a problem without the file's name, which they already show", () => {
    const say = (problem: RefusalNotice) =>
      reasonOnly(problem, messagesFor("en"), formatsFor("en"));
    expect(say({ code: "attachment-kind", name: "budget.xlsx" })).toBe(
      "Only images, PDFs, Word documents and text files.",
    );
    expect(say({ code: "attachment-too-large", name: "scan.png", megabytes: 5 })).toBe(
      "Larger than 5 MB.",
    );
    expect(say({ code: "attachment-empty", name: "cv.pdf" })).toBe("Empty.");
    expect(say({ code: "attachment-no-text", name: "cv.pdf" })).toBe("cv.pdf has no text in it.");
  });

  it("give sizes in the unit that reads best", () => {
    expect(formatSize(70, en, formatsFor("en"))).toBe("70 B");
    expect(formatSize(300 * 1024, en, formatsFor("en"))).toBe("300 KB");
    expect(formatSize(2.1 * 1024 * 1024, en, formatsFor("en"))).toBe("2.1 MB");
  });

  it("give sizes in the app's language", () => {
    expect(formatSize(2.1 * 1024 * 1024, tr, formatsFor("tr"))).toBe("2,1 MB");
  });
});
