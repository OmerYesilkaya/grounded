import { describe, expect, it } from "vitest";
import { describeItem, MANY_TRACKS, searchTracks, shortList } from "./track-list";
import type { ExamItem, HomeworkItem, SessionItem, TrackSummary } from "./tracks";

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
  it("says a homework's name over the session that set it, and when it is handed in", () => {
    const homework: HomeworkItem = {
      kind: "homework",
      id: "h1",
      session: 4,
      title: "Two workers, one counter",
      form: "predict",
      done: false,
      activeAt: "2026-09-29T00:00:00.000Z",
      due: null,
      foldedInto: null,
    };
    expect(describeItem(homework)).toEqual({
      title: "Two workers, one counter",
      meta: "Homework · session 4",
    });
    expect(describeItem({ ...homework, done: true }).meta).toBe("Homework · session 4 · handed in");
    expect(describeItem({ ...homework, done: true, foldedInto: 6 }).meta).toBe(
      "Homework · session 4 · folded into session 6",
    );
  });

  it("says an arc exam's name over the session that set it, and is found by its arcs", () => {
    const exam: ExamItem = {
      kind: "exam",
      id: "e1",
      session: 4,
      title: "Counters everywhere",
      arcs: ["Two workers, one counter"],
      parts: 4,
      done: false,
      activeAt: "2026-09-29T00:00:00.000Z",
      due: null,
    };
    expect(describeItem(exam)).toEqual({
      title: "Counters everywhere",
      meta: "Arc exam · session 4",
    });
    expect(describeItem({ ...exam, done: true }).meta).toBe("Arc exam · session 4 · handed in");
    const concurrency = { ...track("t1", "Concurrency"), items: [exam] };
    expect(searchTracks([concurrency], "arc exam workers")[0]?.items).toEqual([exam]);
  });

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
