import { dueTag, snoozeChoices, type DueTag, type Snooze } from "@grounded/core/snooze";
import { useEffect, useState } from "react";
import type { Formats, Messages } from "@/i18n";

/** The browser's time zone: what "tonight" and "tomorrow" mean to the learner (design §7.4). */
export const browserTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The time now, updated every minute: tags and "due" change as the clock passes their time. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date());
    }, 60_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  return now;
}

/** When an item put off is due, in the browser's time zone: "tonight", "tomorrow", "due"… */
export const tagOf = (due: string, now: Date): DueTag =>
  dueTag(new Date(due), now, browserTimeZone());

/** An item's due tag in words (design §9.2): "tonight", or the date when it is further off. */
export function dueLabel(due: string, now: Date, t: Messages, format: Formats): string {
  const tag = tagOf(due, now);
  return tag === "later"
    ? format.date(due, { day: "numeric", month: "short" })
    : t.common.dueTag[tag];
}

/** The snoozes the learner can pick now: "tonight" only while it is still ahead. */
export const choicesNow = (now: Date): Snooze[] => snoozeChoices(now, browserTimeZone());
