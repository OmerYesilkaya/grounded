import { describe, expect, it } from "vitest";
import { formatSize, reasonOnly } from "./attachment-chip";

describe("attachment chips", () => {
  it("say a problem without the file's name, which they already show", () => {
    expect(reasonOnly("budget.xlsx: only images, PDFs…", "budget.xlsx")).toBe("Only images, PDFs…");
    expect(reasonOnly("scan.png is larger than 5 MB.", "scan.png")).toBe("Larger than 5 MB.");
    expect(reasonOnly("cv.pdf is empty.", "cv.pdf")).toBe("Empty.");
    expect(reasonOnly("Something else.", "cv.pdf")).toBe("Something else.");
  });

  it("give sizes in the unit that reads best", () => {
    expect(formatSize(70)).toBe("70 B");
    expect(formatSize(300 * 1024)).toBe("300 KB");
    expect(formatSize(2.1 * 1024 * 1024)).toBe("2.1 MB");
  });
});
