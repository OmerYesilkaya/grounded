import type { Phase } from "@grounded/core";

/** The phases the session's jobs run today; review, asides, the final and profile refreshes have none yet. */
export type BudgetedPhase = Extract<
  Phase,
  "probe" | "plan" | "lesson" | "check" | "homework" | "close"
>;

/**
 * The most input one call of a phase may send on a large track (design §4.4), in estimated tokens:
 * the system prompt and the conversation, on a track like the imported one (204 terms, 34 KB of
 * plan notes) with a normal session's chat (`prompt-budget.test.ts`, which fails when a change
 * pushes a call past it). Each is about a fifth above what the calls send now. Before #13's part 2
 * every one of these calls sent about 30,000.
 * - plan: the whole plan, every arc with its terms (its set-plan replaces the plan).
 * - close: the whole plan and the plan's notes as written, which only the close reads.
 */
export const PROMPT_BUDGETS: Readonly<Record<BudgetedPhase, number>> = {
  probe: 12_000,
  plan: 17_000,
  lesson: 12_500,
  check: 10_000,
  homework: 12_500,
  close: 25_000,
};

/** A rough count of tokens: about four characters each for English prose and markdown. */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);
