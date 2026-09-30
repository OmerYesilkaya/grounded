import { describe, expect, it } from "vitest";
import { dueTag, isTimeZone, snoozeChoices, snoozeUntil } from "./snooze.js";

const ISTANBUL = "Europe/Istanbul"; // UTC+3 all year
const BERLIN = "Europe/Berlin";
const NEW_YORK = "America/New_York";

describe("snoozeUntil", () => {
  it("puts tonight at 8 p.m. and tomorrow at 9 a.m. of the learner's own clock", () => {
    const now = new Date("2026-09-29T11:00:00Z"); // 14:00 in Istanbul
    expect(snoozeUntil("tonight", now, ISTANBUL)?.toISOString()).toBe("2026-09-29T17:00:00.000Z");
    expect(snoozeUntil("tomorrow", now, ISTANBUL)?.toISOString()).toBe("2026-09-30T06:00:00.000Z");
    expect(snoozeUntil("tonight", now, NEW_YORK)?.toISOString()).toBe("2026-09-30T00:00:00.000Z");
  });

  it("has no tonight once 8 p.m. has passed", () => {
    const late = new Date("2026-09-29T18:30:00Z"); // 21:30 in Istanbul
    expect(snoozeUntil("tonight", late, ISTANBUL)).toBeNull();
    expect(snoozeChoices(late, ISTANBUL)).toEqual(["tomorrow"]);
    expect(snoozeChoices(new Date("2026-09-29T11:00:00Z"), ISTANBUL)).toEqual([
      "tonight",
      "tomorrow",
    ]);
  });

  it("takes tomorrow after midnight as after sleeping", () => {
    const small = new Date("2026-09-29T22:00:00Z"); // 01:00 on the 30th in Istanbul
    expect(snoozeUntil("tomorrow", small, ISTANBUL)?.toISOString()).toBe(
      "2026-09-30T06:00:00.000Z",
    );
    expect(snoozeUntil("tonight", small, ISTANBUL)).toBeNull();
  });

  it("rolls over a month's end and keeps the hour across a change of clocks", () => {
    // Berlin leaves summer time on 25 October 2026.
    const before = new Date("2026-10-24T10:00:00Z");
    expect(snoozeUntil("tomorrow", before, BERLIN)?.toISOString()).toBe("2026-10-25T08:00:00.000Z");
    const monthEnd = new Date("2026-09-30T10:00:00Z");
    expect(snoozeUntil("tomorrow", monthEnd, BERLIN)?.toISOString()).toBe(
      "2026-10-01T07:00:00.000Z",
    );
  });
});

describe("dueTag", () => {
  const now = new Date("2026-09-29T11:00:00Z"); // 14:00 in Istanbul

  it("says when it is due, in the learner's days", () => {
    expect(dueTag(new Date("2026-09-29T17:00:00Z"), now, ISTANBUL)).toBe("tonight");
    expect(dueTag(new Date("2026-09-29T12:00:00Z"), now, ISTANBUL)).toBe("today");
    expect(dueTag(new Date("2026-09-30T06:00:00Z"), now, ISTANBUL)).toBe("tomorrow");
    expect(dueTag(new Date("2026-10-03T06:00:00Z"), now, ISTANBUL)).toBe("later");
  });

  it("says due once its time has come", () => {
    expect(dueTag(new Date("2026-09-29T10:59:00Z"), now, ISTANBUL)).toBe("due");
    // Tomorrow's snooze, seen at 1 a.m. before it: still tomorrow to the learner.
    const small = new Date("2026-09-29T22:00:00Z");
    expect(dueTag(new Date("2026-09-30T06:00:00Z"), small, ISTANBUL)).toBe("tomorrow");
  });
});

describe("isTimeZone", () => {
  it("knows a time zone's name from anything else", () => {
    expect(isTimeZone(ISTANBUL)).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
  });
});
