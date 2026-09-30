/*
 * "Later" with a snooze (design §7.4): homework put off until tonight or tomorrow, in the learner's
 * own time zone, which the browser sends. Shared by the server, which sets the time, and the
 * browser, which offers the choices and tags the item in the track list.
 */

export const SNOOZES = ["tonight", "tomorrow"] as const;
export type Snooze = (typeof SNOOZES)[number];

/**
 * The learner's day starts at 4 in the morning, not at midnight: "tomorrow" said at 1 a.m. means
 * after sleeping, and "tonight" at 1 a.m. is over.
 */
const DAY_STARTS_AT = 4;
/** When "tonight" is: 8 p.m. of the learner's day. */
const TONIGHT_AT = 20;
/** When "tomorrow" is: 9 a.m. of the learner's next day. */
const TOMORROW_AT = 9;

const HOUR = 60 * 60 * 1000;

/** Whether the browser's time zone name is one the runtime knows ("Europe/Istanbul"). */
export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formats = new Map<string, Intl.DateTimeFormat>();

/** What a clock in the time zone shows at this instant. */
function wallClock(instant: Date, timeZone: string): WallClock {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formats.set(timeZone, format);
  }
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(format.formatToParts(instant).find((p) => p.type === type)?.value ?? 0);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
  };
}

/** The instant a clock in the time zone shows this day at this hour (days past a month's end roll on). */
function instantAt(
  timeZone: string,
  day: { year: number; month: number; day: number },
  hour: number,
) {
  const wanted = Date.UTC(day.year, day.month - 1, day.day, hour);
  // The zone's offset near that time, measured twice so a change of clocks in between is caught.
  const offsetAt = (instant: number) => {
    const shown = wallClock(new Date(instant), timeZone);
    return (
      Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute) -
      Math.floor(instant / 60_000) * 60_000
    );
  };
  const first = wanted - offsetAt(wanted);
  return new Date(wanted - offsetAt(first));
}

/** The learner's day at this instant: its calendar date, the day starting at 4 a.m. */
function learnerDay(instant: Date, timeZone: string) {
  const { year, month, day } = wallClock(
    new Date(instant.getTime() - DAY_STARTS_AT * HOUR),
    timeZone,
  );
  return { year, month, day };
}

/** Days from one learner's day to another's. */
const daysBetween = (
  a: { year: number; month: number; day: number },
  b: { year: number; month: number; day: number },
) =>
  Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / (24 * HOUR),
  );

/**
 * When a snooze chosen now ends, in the learner's time zone; null for "tonight" once tonight's time
 * has passed (the browser offers only "tomorrow" then).
 */
export function snoozeUntil(snooze: Snooze, now: Date, timeZone: string): Date | null {
  const today = learnerDay(now, timeZone);
  if (snooze === "tomorrow")
    return instantAt(timeZone, { ...today, day: today.day + 1 }, TOMORROW_AT);
  const tonight = instantAt(timeZone, today, TONIGHT_AT);
  return tonight > now ? tonight : null;
}

/** The snoozes the learner can choose now: "tonight" only while it is still ahead. */
export function snoozeChoices(now: Date, timeZone: string): Snooze[] {
  return SNOOZES.filter((snooze) => snoozeUntil(snooze, now, timeZone) !== null);
}

/** What a snoozed item's tag says; "later" is its date, which the browser writes in its language. */
export type DueTag = "due" | "today" | "tonight" | "tomorrow" | "later";

/**
 * The tag on a snoozed item (design §9.2): "due" once its time has come; before that, when it is
 * due in the learner's days: "tonight" (or "today", before the evening), "tomorrow", or later (the
 * date).
 */
export function dueTag(until: Date, now: Date, timeZone: string): DueTag {
  if (until <= now) return "due";
  const days = daysBetween(learnerDay(now, timeZone), learnerDay(until, timeZone));
  if (days <= 0) return wallClock(until, timeZone).hour >= 17 ? "tonight" : "today";
  if (days === 1) return "tomorrow";
  return "later";
}
