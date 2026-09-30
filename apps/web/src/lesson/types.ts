import type { Block } from "@grounded/content";
import type { AsideAnchor } from "@grounded/core/aside-anchor";
import type { FailureNotice } from "@grounded/core/notices";

export type { AsideAnchor };

/** A message of an aside's thread: the learner's words, or the tutor's validated blocks. */
export interface AsideMessage {
  id: string;
  role: "learner" | "tutor";
  text: string | null;
  blocks: Block[] | null;
  /** The app's answer in place of the tutor's, when it couldn't be given (design §9.3). */
  failure?: FailureNotice | null;
}

/** A question asked on a passage of the lesson, answered in the margin (design §7.5). */
export interface Aside {
  id: string;
  stepId: string;
  anchor: AsideAnchor;
  messages: AsideMessage[];
  /** The answer so far, while the last question is being answered; null otherwise. */
  draft: string | null;
  /** A tangent the tutor offered to save for a future session; null if none. */
  tangent: string | null;
  saved: boolean;
}

/** What the lesson view needs for asides; without it, the lesson takes no questions. */
export interface LessonAsides {
  items: readonly Aside[];
  /** The learner has never asked: the empty margin shows how (design §9.1). */
  hint: boolean;
  /** Questions can be asked (the session is open). */
  canAsk: boolean;
  /** Asks on a passage; resolves with the new aside's id. */
  onAsk: (anchor: AsideAnchor, text: string) => Promise<string>;
  onFollowUp: (asideId: string, text: string) => Promise<void>;
  onSave: (asideId: string) => void;
}

export type CheckMessage =
  | { from: "learner"; text: string }
  | {
      from: "tutor";
      blocks: Block[];
      verdict?: "landed" | "missed";
      /** The app's reply in place of the tutor's (design §9.3), shown in its place. */
      failure?: FailureNotice;
    };

/**
 * open: waiting for an answer · passed: the check landed · settling: continued past while shaky ·
 * paused: the learner chose to come back to it next time · unchecked: the step has no check, so it
 * opens with the step before it.
 */
export type StepStatus = "open" | "passed" | "settling" | "paused" | "unchecked";

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
