import { queryOptions } from "@tanstack/react-query";
import type { Formats } from "@/i18n";
import { api } from "./api";

/** What a set of model calls used (api: routes/usage.ts). */
export interface UsageTotal {
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** USD at the model list's prices; null when none of the calls' models has a price. */
  costUsd: number | null;
  /** Calls on a model with no price yet, left out of `costUsd`. */
  unpriced: number;
}

export interface UsageReport {
  months: ({ month: string } & UsageTotal)[];
  sessions: ({
    id: string;
    trackId: string;
    trackTitle: string;
    number: number;
    startedAt: string;
  } & UsageTotal)[];
}

export const usageQuery = queryOptions({
  queryKey: ["usage"],
  queryFn: () =>
    api<UsageReport>(
      `/api/usage?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`,
    ),
});

const USD = { style: "currency", currency: "USD" } as const;

/** "$3.42", "<$0.01", or "—" when nothing had a price; in the app's language ("$3,42"). */
export function formatCost(usd: number | null, format: Formats): string {
  if (usd === null) return "—";
  if (usd > 0 && usd < 0.01) return `<${format.number(0.01, USD)}`;
  return format.number(usd, USD);
}

/** "1.2M", "840K", "96"; in Turkish "1,2 Mn", "840 B". */
export function formatTokens(tokens: number, format: Formats): string {
  return format.number(tokens, { notation: "compact", maximumFractionDigits: 1 });
}

/** "September 2026" for "2026-09"; "Eylül 2026" in Turkish. */
export function monthName(
  month: string,
  format: Formats,
  options: { year?: boolean } = {},
): string {
  const [year, index] = month.split("-").map(Number);
  return format.date(Date.UTC(year ?? 1970, (index ?? 1) - 1, 1), {
    month: "long",
    ...(options.year === false ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}
