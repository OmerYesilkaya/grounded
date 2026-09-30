import { AsyncLocalStorage } from "node:async_hooks";
import type { CallVerdict, Judge } from "@grounded/core";

export type { CallVerdict, Judge };

/**
 * Validator verdicts for stored model calls (design §4.4). The middleware stores every call
 * (model-call.ts) but can't know what the caller's validators make of the reply; the caller runs
 * the call in `traced`, validates what came back, and passes the verdict to `judge`, which records
 * it on the call. Nothing is passed around: the calls are found through the async context, as the
 * log's fields are (log.ts).
 */

/** The calls that answered within one traced run, in the order they finished. */
export interface Trace {
  /** Each records its call's verdict. */
  calls: Judge[];
}

const traces = new AsyncLocalStorage<Trace>();

/** The run the current code is traced in, if any: the middleware stores its calls into it. */
export const currentTrace = (): Trace | undefined => traces.getStore();

/**
 * Runs `run`, keeping the model calls it makes; `judge` then records a verdict on the one whose
 * reply was validated: the last that answered (an attempt before it failed, or came back empty and
 * was asked again). A traced run within it keeps its own calls. Where no call was stored (a
 * test's scripted model), `judge` does nothing. It is the lesson pipeline's CallTracer (core).
 */
export async function traced<T>(run: () => PromiseLike<T>): Promise<{ value: T; judge: Judge }> {
  const trace: Trace = { calls: [] };
  const value = await traces.run(trace, run);
  return {
    value,
    judge: async (verdict) => {
      await trace.calls.at(-1)?.(verdict);
    },
  };
}

/**
 * A verdict's issues from the validators' own: their codes, messages and steps, or messages alone.
 */
export const verdictIssues = (
  issues: readonly (string | { code?: string; message: string; stepId?: string })[],
): CallVerdict["issues"] =>
  issues.map((issue) =>
    typeof issue === "string"
      ? { message: issue }
      : {
          ...(issue.code ? { code: issue.code } : {}),
          message: issue.message,
          ...(issue.stepId ? { stepId: issue.stepId } : {}),
        },
  );
