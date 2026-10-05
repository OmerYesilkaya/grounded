import type { LanguageModelV4 } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import { causeOf } from "../engine/model-call.js";

/*
 * Reading a source makes many calls to the learner's cheap model back to back (design §4.6): pages
 * transcribed, long chapters divided, chapters summarized. A provider's per-minute allowance can
 * run out partway, which a call reports as the provider limiting requests. A reading has nobody
 * waiting on it, so it waits the minute out and goes on, rather than stopping and asking the
 * learner to try again.
 */

/** How long to wait when the provider is limiting requests, and how many times. */
export const PACE_WAIT_MS = 60_000;
export const PACE_WAITS = 5;

const rateLimited = (error: unknown) => {
  const cause = causeOf(error);
  return cause?.code === "provider-failed" && cause.kind === "rate-limited";
};

/** The model, waiting out the provider's rate limit before each call is tried again. */
export function pacedModel(
  model: LanguageModelV4,
  options: { waitMs?: number; waits?: number; sleep?: (ms: number) => Promise<void> } = {},
): LanguageModelV4 {
  const waitMs = options.waitMs ?? PACE_WAIT_MS;
  const waits = options.waits ?? PACE_WAITS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const paced = async <T>(call: () => PromiseLike<T>): Promise<T> => {
    for (let waited = 0; ; waited++) {
      try {
        return await call();
      } catch (error) {
        if (!rateLimited(error) || waited >= waits) throw error;
        await sleep(waitMs);
      }
    }
  };
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: ({ doGenerate }) => paced(doGenerate),
      wrapStream: ({ doStream }) => paced(doStream),
    },
  });
}
