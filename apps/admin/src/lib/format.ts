import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const usd = (value: number | null) =>
  value === null ? "no price" : value < 0.01 && value > 0 ? "<$0.01" : `$${value.toFixed(2)}`;

export const count = (value: number) => value.toLocaleString("en");

/** A share as a whole percent, or a dash when there is nothing to share. */
export const percent = (part: number, whole: number) =>
  whole === 0 ? "–" : `${String(Math.round((part / whole) * 100))}%`;

export const duration = (ms: number | null) =>
  ms === null ? "–" : ms < 1000 ? `${String(Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;

const dateTime = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const time = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export const when = (iso: string | null) => (iso ? dateTime.format(new Date(iso)) : "–");
/** A moment in a session, to the second; with its day, as a session can run over several. */
export const clock = (iso: string) => time.format(new Date(iso));

/** "1 learner", "2 learners". */
export const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** How long ago, in the largest whole unit. */
export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 60) return `${String(Math.max(minutes, 0))} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)} h ago`;
  return `${String(Math.round(hours / 24))} days ago`;
}

export const learnerName = (n: number) => `Learner ${String(n)}`;
