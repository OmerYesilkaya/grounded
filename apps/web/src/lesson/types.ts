import type { Block } from "@grounded/content";

export type CheckMessage =
  | { from: "learner"; text: string }
  | { from: "tutor"; blocks: Block[]; verdict?: "landed" | "missed" };

/**
 * open: waiting for an answer · passed: the check landed · settling: continued past while shaky ·
 * paused: the learner chose to come back to it next time.
 */
export type StepStatus = "open" | "passed" | "settling" | "paused";

/** What the server knows about one step's check; the view only shows it. */
export interface StepProgress {
  status: StepStatus;
  thread: CheckMessage[];
  /** An answer is being graded. */
  grading?: boolean;
  /** Still shaky after a repair, and the next step rests on this one: offer pause or continue. */
  offerGate?: boolean;
  /** The "after the check" note recorded under the step. */
  note?: string;
}
