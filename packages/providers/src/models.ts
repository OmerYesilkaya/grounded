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
  /** cacheWrite: input written to the provider cache (Anthropic: 2x input at the 1-hour lifetime). */
  price: { input: number; cachedInput: number; cacheWrite: number; output: number } | null;
  /** passed: eval harness · manual: tested by hand · pending: not evaluated (development only). */
  gate: "passed" | "manual" | "pending";
  /**
   * The attached files the model reads as they are (design §4.5). A file of a kind it doesn't read
   * is replaced, in the model middleware, by a line saying so.
   */
  reads: { images: boolean; pdfs: boolean };
}

const READS_ALL = { images: true, pdfs: true } as const;

export const MODELS: readonly ModelEntry[] = [
  {
    // Passed Omer's quality test (2026-09-28).
    id: "claude-opus-5-5",
    provider: "anthropic",
    label: "Claude Opus 5.5",
    roles: ["strong"],
    price: { input: 4, cachedInput: 0.2, cacheWrite: 8, output: 20 },
    gate: "manual",
    reads: READS_ALL,
  },
  {
    // Passed Omer's quality test (2026-09-28).
    id: "claude-sonnet-5-5",
    provider: "anthropic",
    label: "Claude Sonnet 5.5",
    roles: ["strong"],
    price: { input: 2, cachedInput: 0.2, cacheWrite: 4, output: 10 },
    gate: "manual",
    reads: READS_ALL,
  },
  {
    // Passed Omer's quality test (2026-09-28).
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    label: "Claude Haiku 4.5",
    roles: ["cheap"],
    price: { input: 1, cachedInput: 0.1, cacheWrite: 2, output: 5 },
    gate: "manual",
    reads: READS_ALL,
  },
  {
    // Tested by Omer with the chat-app method and costed as acceptable (2026-09-27).
    id: "gpt-6-luna",
    provider: "openai",
    label: "GPT-6 Luna",
    roles: ["strong", "cheap"],
    price: null,
    gate: "manual",
    reads: READS_ALL,
  },
  {
    // Google's stable Flash line; the Pro model is a preview (gemini-3.1-pro-preview) and could be
    // withdrawn under a learner. Prices are the introductory ones, to 2026-12-31; they double from
    // 2027-01-01 ($1.50 in, $0.15 cached, $7.50 out). Gemini caches implicitly at no write premium.
    id: "gemini-3.8-flash",
    provider: "google",
    label: "Gemini 3.8 Flash",
    roles: ["strong"],
    price: { input: 0.75, cachedInput: 0.075, cacheWrite: 0.75, output: 3.75 },
    gate: "manual",
    reads: READS_ALL,
  },
  {
    id: "gemini-3.5-flash-lite",
    provider: "google",
    label: "Gemini 3.5 Flash-Lite",
    roles: ["cheap"],
    price: { input: 0.3, cachedInput: 0.03, cacheWrite: 0.3, output: 2.5 },
    gate: "manual",
    reads: READS_ALL,
  },
  {
    // DeepSeek's prices are the standard (peak-hour) ones; off-peak (outside 01:00–04:00 and
    // 06:00–10:00 UTC on weekdays) every rate is half, so the estimate errs high. Its cache is
    // implicit, at no write premium.
    id: "deepseek-v4-pro",
    provider: "deepseek",
    label: "DeepSeek V4 Pro",
    roles: ["strong"],
    price: { input: 1.32, cachedInput: 0.044, cacheWrite: 1.32, output: 3.96 },
    gate: "manual",
    // Text only; DeepSeek's API takes PDFs on neither model.
    reads: { images: false, pdfs: false },
  },
  {
    // DeepSeek-V4.1-Flash, under its standing name.
    id: "deepseek-flash",
    provider: "deepseek",
    label: "DeepSeek Flash",
    roles: ["strong", "cheap"],
    price: { input: 0.3, cachedInput: 0.006, cacheWrite: 0.3, output: 1.2 },
    gate: "manual",
    reads: { images: true, pdfs: false },
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

/** The kinds of file a model may not read (design §4.5); anything else goes as text. */
export type FileKind = "image" | "pdf";

export function fileKindOf(mediaType: string): FileKind | null {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType === "application/pdf") return "pdf";
  return null;
}

/** Whether the model reads a file of this media type as it is; a model not on the list is trusted to. */
export function modelReads(modelId: string, mediaType: string): boolean {
  const entry = findModel(modelId);
  const kind = fileKindOf(mediaType);
  if (!entry || !kind) return true;
  return kind === "image" ? entry.reads.images : entry.reads.pdfs;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  /** Input written to the provider's cache; 0 where it isn't reported. */
  cacheWriteTokens?: number;
  outputTokens: number;
}

/**
 * USD. Input read from the cache is billed at the cached rate, input written to it at the cache
 * write rate; both are part of inputTokens.
 */
export function estimateCost(modelId: string, usage: TokenUsage): number | null {
  const price = findModel(modelId)?.price;
  if (!price) return null;
  const written = usage.cacheWriteTokens ?? 0;
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens - written);
  return (
    (uncached * price.input +
      usage.cachedInputTokens * price.cachedInput +
      written * price.cacheWrite +
      usage.outputTokens * price.output) /
    1e6
  );
}
