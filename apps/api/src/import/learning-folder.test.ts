import { describe, expect, it } from "vitest";
import { LATEST_LESSON, OWED_HOMEWORK, writeLearningFixture } from "../test/learning-fixture.js";
import { htmlTitle, readLearningTrack, sectionsOf, titleFromSlug } from "./learning-folder.js";
import { demote } from "./notes.js";

describe("readLearningTrack", () => {
  it("reads the state, the handoff, the README row, the last lesson and the owed homework", async () => {
    const track = await readLearningTrack(await writeLearningFixture());

    expect(track.slug).toBe("cooking-basics");
    expect(track.title).toBe("Cooking basics");
    expect(track.readmeRow).toBe(
      "| `cooking-basics` | Cooking from first principles. | Arc B started. |",
    );
    expect([...track.sections.keys()]).toEqual([
      "Ledger",
      "Map",
      "Plan",
      "Borrowed",
      "Session log",
      "Open threads carried forward",
    ]);
    expect(track.latestLesson).toEqual({
      folder: "2026-01-05-sauces",
      title: "Sauces & emulsions — 2026-01-05",
      html: LATEST_LESSON,
    });
    expect(track.owedHomework).toEqual({ folder: "2026-01-03-heat", text: OWED_HOMEWORK });
    expect(track.otherUnansweredHomework).toEqual(["2026-01-02-stocks"]);
    expect(track.snapshotDate).toBe("2026-01-05");
  });

  it("refuses a folder without state.md", async () => {
    await expect(readLearningTrack("/nonexistent")).rejects.toThrow(/state\.md/);
  });
});

describe("parsing helpers", () => {
  it("never takes a line inside a code fence for a heading", () => {
    const sections = sectionsOf("## Map\n\n```\n## inside\n```\n\n## Plan\n\nA → B");
    expect(sections).toEqual(
      new Map([
        ["Map", "```\n## inside\n```"],
        ["Plan", "A → B"],
      ]),
    );
  });

  it("pushes copied headings four levels down, capped at six, leaving code alone", () => {
    expect(demote("# One\n## Two\n### Three\n```\n# code\n```")).toBe(
      "##### One\n###### Two\n###### Three\n```\n# code\n```",
    );
  });

  it("names a track from its slug and a lesson from its title", () => {
    expect(titleFromSlug("how-software-works")).toBe("How software works");
    expect(htmlTitle("<title> A &lt;b&gt; &amp; c </title>")).toBe("A <b> & c");
    expect(htmlTitle("<p>no title</p>")).toBeNull();
  });
});
