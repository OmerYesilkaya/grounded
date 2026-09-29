import { dueTag, snoozeChoices, type Snooze } from "@grounded/core/snooze";
import { useEffect, useState } from "react";

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

/** An item's due tag, in the browser's time zone: "tonight", "tomorrow", "due". */
export const tagOf = (due: string, now: Date): string =>
  dueTag(new Date(due), now, browserTimeZone());

/** When put-off homework is due, as a sentence's start: "Due tonight:", "Due now:". */
export const dueWords = (due: string, now: Date): string => {
  const tag = tagOf(due, now);
  return `Due ${tag === "due" ? "now" : tag}:`;
};

export const SNOOZE_WORDS: Record<Snooze, string> = { tonight: "Tonight", tomorrow: "Tomorrow" };

/** The snoozes the learner can pick now: "tonight" only while it is still ahead. */
export const choicesNow = (now: Date): Snooze[] => snoozeChoices(now, browserTimeZone());
