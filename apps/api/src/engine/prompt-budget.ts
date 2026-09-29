import type { Phase } from "@grounded/core";

/** The phases the session's jobs run today; the final and profile refreshes have none yet. */
export type BudgetedPhase = Extract<
  Phase,
  "review" | "probe" | "plan" | "lesson" | "check" | "homework" | "close" | "aside"
>;

/**
 * The most input one call of a phase may send on a large track (design §4.4), in estimated tokens:
 * the system prompt and the conversation, on a track like the imported one (204 terms, 34 KB of
 * plan notes) with a normal session's chat (`prompt-budget.test.ts`, which fails when a change
 * pushes a call past it). Each is about a fifth above what the calls send now. Before #13's part 2
 * every one of these calls sent about 30,000.
 * - plan: the whole plan, every arc with its terms (it places its new terms in the arcs they belong to),
 *   and up to 300 terms held in the learner's other tracks, to borrow (#54).
 * - close: the whole plan and the plan's notes as written, which only the close reads.
 * - review: the opening review (#40) at its largest: an arc exam's review and a homework's, twelve
 *   open comments with their threads, two steps left shaky with their sources and check threads,
 *   and four answers: ~12,300 on the large track.
 * - aside: the whole lesson (six steps of a real one's size, about 20 KB) and two earlier asides.
 * - wording-review: the cheap model's review of one text (#52): the whole term list by name, and the
 *   text: ~4,600 measured for a probe question on the large track; a lesson step of about 3 KB adds
 *   some 800 more.
 * - exam: the arc exam (#42), written in the homework's phase after the homework: its prompt, the
 *   homework's message, and the arc it covers whole, each term with what it rests on and the
 *   sessions that taught it: ~13,200 on the large track, whose arcs have 17 terms.
 */
export const PROMPT_BUDGETS: Readonly<Record<BudgetedPhase | "wording-review" | "exam", number>> = {
  review: 15_000,
  probe: 12_000,
  plan: 20_000,
  lesson: 12_500,
  check: 10_000,
  homework: 12_500,
  close: 25_000,
  aside: 16_000,
  "wording-review": 7_000,
  exam: 16_000,
};

/** A rough count of tokens: about four characters each for English prose and markdown. */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);
