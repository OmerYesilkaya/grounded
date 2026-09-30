/*
 * What the app's validators decided about a model call's reply, stored on the call (design §4.4).
 * The API stores the calls and records the verdicts (apps/api/src/engine/call-trace.ts); what makes
 * calls here (the lesson pipeline) is handed a tracer, so it can say what it judged without
 * knowing how the verdict is kept.
 */

export interface VerdictIssue {
  code?: string;
  message: string;
  /** The lesson step the issue is in, for a call that writes several (the lesson's stream). */
  stepId?: string;
}

export interface CallVerdict {
  /** Which writing the call was: 0 the first, 1 the rewrite asked for after it broke a rule, … */
  rewrite: number;
  /** What the validators found in the reply, the review's judgments included; none: it passed. */
  issues: VerdictIssue[];
}

/**
 * Records a verdict on a call. A second verdict on the same call, from another validator (the
 * track edits a check's grading made, beside its reply), adds its issues to the first's.
 */
export type Judge = (verdict: CallVerdict) => Promise<void>;

/** Runs a model call so that its verdict can be recorded on it, once its reply is validated. */
export type CallTracer = <T>(run: () => PromiseLike<T>) => Promise<{ value: T; judge: Judge }>;

/** A tracer that records nothing, where no one keeps the verdicts. */
export const untraced: CallTracer = async (run) => ({
  value: await run(),
  judge: () => Promise.resolve(),
});
