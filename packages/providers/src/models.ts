import type { ProviderId } from "./errors.js";

/**
 * The models learners can choose (design §4.4). A model joins with its eval results; until the eval
 * harness exists, `gate` records how it was checked. Prices are USD per million tokens; null when not
 * yet confirmed (cost then shows as unknown rather than guessed).
 */
export interface ModelEntry {
  id: string;
  provider: ProviderId;
  label: string;
  /** strong: planning, lessons, grading, reviews · cheap: asides and small jobs. */
  roles: readonly ("strong" | "cheap")[];
  price: { input: number; cachedInput: number; output: number } | null;
  /** passed: eval harness · manual: tested by hand · pending: not evaluated (development only). */
  gate: "passed" | "manual" | "pending";
}

export const MODELS: readonly ModelEntry[] = [
  {
    // Passed Omer's quality test (2026-09-28).
    id: "claude-opus-5-5",
    provider: "anthropic",
    label: "Claude Opus 5.5",
    roles: ["strong"],
    price: { input: 4, cachedInput: 0.2, output: 20 },
    gate: "manual",
  },
  {
    // Passed Omer's quality test (2026-09-28).
    id: "claude-sonnet-5-5",
    provider: "anthropic",
    label: "Claude Sonnet 5.5",
    roles: ["strong"],
    price: { input: 2, cachedInput: 0.2, output: 10 },
    gate: "manual",
  },
  {
    // Passed Omer's quality test (2026-09-28).
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    label: "Claude Haiku 4.5",
    roles: ["cheap"],
    price: { input: 1, cachedInput: 0.1, output: 5 },
    gate: "manual",
  },
  {
    // Tested by Omer with the chat-app method and costed as acceptable (2026-09-27).
    id: "gpt-6-luna",
    provider: "openai",
    label: "GPT-6 Luna",
    roles: ["strong", "cheap"],
    price: null,
    gate: "manual",
  },
];

export function findModel(id: string): ModelEntry | undefined {
  return MODELS.find((m) => m.id === id);
}

/** Models a learner may pick for their provider (strong role). */
export function offeredModels(
  provider: ProviderId,
  options: { includeUngated: boolean },
): ModelEntry[] {
  return MODELS.filter(
    (m) =>
      m.provider === provider &&
      m.roles.includes("strong") &&
      (options.includeUngated || m.gate !== "pending"),
  );
}

export function cheapModelFor(provider: ProviderId): ModelEntry | undefined {
  return MODELS.find((m) => m.provider === provider && m.roles.includes("cheap"));
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** USD; cached input tokens are billed at the cached rate and are part of inputTokens. */
export function estimateCost(modelId: string, usage: TokenUsage): number | null {
  const price = findModel(modelId)?.price;
  if (!price) return null;
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    (uncached * price.input +
      usage.cachedInputTokens * price.cachedInput +
      usage.outputTokens * price.output) /
    1e6
  );
}
