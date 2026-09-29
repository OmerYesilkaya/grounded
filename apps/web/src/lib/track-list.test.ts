import { describe, expect, it } from "vitest";
import { describeItem, MANY_TRACKS, searchTracks, shortList } from "./track-list";
import type { SessionItem, TrackSummary } from "./tracks";

const session = (number: number, fields: Partial<SessionItem> = {}): SessionItem => ({
  kind: "session",
  id: `s${String(number)}`,
  number,
  phase: "closed",
  done: true,
  terms: [],
  lessonTitle: null,
  activeAt: "2026-09-29T00:00:00.000Z",
  ...fields,
});

const track = (id: string, title: string, items: SessionItem[] = []): TrackSummary => ({
  id,
  title,
  naming: false,
  language: null,
  activeAt: "2026-09-29T00:00:00.000Z",
  items,
  openSession: null,
  importedLesson: null,
  files: [],
});

describe("an item's row", () => {
  it("says what the session's lesson teaches, over its number and phase", () => {
    expect(
      describeItem(
        session(4, { done: false, phase: "lesson", terms: ["working copy", "lost update"] }),
      ),
    ).toEqual({ title: "Working copy, lost update", meta: "Session 4 · lesson" });
    expect(describeItem(session(2, { terms: ["pointer"] }))).toEqual({
      title: "Pointer",
      meta: "Session 2",
    });
  });

  it("says the lesson's title where it has one, over its number and phase", () => {
    expect(
      describeItem(
        session(4, {
          done: false,
          phase: "lesson",
          terms: ["working copy", "lost update"],
          lessonTitle: "Why two writers lose an update",
        }),
      ),
    ).toEqual({ title: "Why two writers lose an update", meta: "Session 4 · lesson" });
  });

  it("says what is under way before there is a lesson", () => {
    expect(describeItem(session(1, { done: false, phase: "probe" }))).toEqual({
      title: "Finding where you start",
      meta: "Session 1",
    });
  });
});

describe("searching the track list", () => {
  const tracks = [
    track("sw", "How software works", [
      session(1, { terms: ["bit", "byte"] }),
      session(2, { terms: ["memory address", "pointer"] }),
    ]),
    track("sql", "SQL", [
      session(1, { terms: ["join"], lessonTitle: "Asking two tables at once" }),
      session(2, { terms: ["index"] }),
    ]),
    track("eg", "Antik Mısır Tarihi"),
  ];
  const ids = (query: string) =>
    searchTracks(tracks, query).map(({ track, items }) => [
      track.id,
      items?.map((i) => i.id) ?? "all",
    ]);

  it("finds a track whole by its name, and otherwise by the lessons that match", () => {
    expect(ids("software")).toEqual([["sw", "all"]]);
    expect(ids("pointer")).toEqual([["sw", ["s2"]]]);
    // By its title, and by the terms a titled lesson teaches.
    expect(ids("two tables")).toEqual([["sql", ["s1"]]]);
    expect(ids("join")).toEqual([["sql", ["s1"]]]);
    expect(ids("  ")).toEqual([
      ["sw", "all"],
      ["sql", "all"],
      ["eg", "all"],
    ]);
  });

  it("needs every word, in any order, the track's name counting for its lessons", () => {
    expect(ids("sql join")).toEqual([["sql", ["s1"]]]);
    expect(ids("join index")).toEqual([]);
  });

  it("ignores case and accents", () => {
    expect(ids("MISIR")).toEqual([["eg", "all"]]);
    expect(ids("misir")).toEqual([["eg", "all"]]);
  });
});

describe("the track list at scale", () => {
  const many = Array.from({ length: MANY_TRACKS }, (_, i) =>
    track(`t${String(i)}`, `Track ${String(i)}`),
  );

  it("shows every track below the limit", () => {
    expect(shortList(many.slice(1), undefined, false)).toMatchObject({ hidden: 0 });
  });

  it("shows the six most recently active, and the page's track wherever it falls", () => {
    const { shown, hidden } = shortList(many, "t12", false);
    expect(shown.map((t) => t.id)).toEqual(["t0", "t1", "t2", "t3", "t4", "t5", "t12"]);
    expect(hidden).toBe(MANY_TRACKS - 7);
    expect(shortList(many, undefined, true).shown).toHaveLength(MANY_TRACKS);
  });
});
