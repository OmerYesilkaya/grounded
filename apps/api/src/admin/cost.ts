import { sql } from "@grounded/db";
import { estimateCost } from "@grounded/providers";

/**
 * Token sums for one model, as the cost queries select them. A type, not an interface: a raw
 * query's rows must be assignable to Record<string, unknown>, which only a type is.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type ModelTokens = {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
};

/** The token sums of the calls (`u`) in a group, for costing them per model. */
export const TOKEN_SUMS = sql`
  coalesce(sum(u.input_tokens), 0)::bigint::float8 as "inputTokens",
  coalesce(sum(u.cached_input_tokens), 0)::bigint::float8 as "cachedInputTokens",
  coalesce(sum(u.cache_write_tokens), 0)::bigint::float8 as "cacheWriteTokens",
  coalesce(sum(u.output_tokens), 0)::bigint::float8 as "outputTokens"`;

/** USD at the model list's prices (design §4.4); models with no price add nothing. */
export function costOf(rows: readonly ModelTokens[]): number {
  return rows.reduce((sum, row) => sum + (estimateCost(row.model, row) ?? 0), 0);
}
