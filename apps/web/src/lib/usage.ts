import { queryOptions } from "@tanstack/react-query";
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

/** "$3.42", "<$0.01", or "—" when nothing had a price. */
export function formatCost(usd: number | null): string {
  if (usd === null) return "—";
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return new Intl.NumberFormat("en", { style: "currency", currency: "USD" }).format(usd);
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** "1.2M", "840K", "96". */
export function formatTokens(tokens: number): string {
  return compact.format(tokens);
}

/** "September 2026" for "2026-09". */
export function monthName(month: string, options: { year?: boolean } = {}): string {
  const [year, index] = month.split("-").map(Number);
  return new Date(Date.UTC(year ?? 1970, (index ?? 1) - 1, 1)).toLocaleDateString("en", {
    month: "long",
    ...(options.year === false ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}
