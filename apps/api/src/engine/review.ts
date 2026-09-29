import { reviewWording, type Reviewer } from "@grounded/core";
import { log } from "../log.js";
import type { ModelAccess } from "./model-call.js";

/**
 * The review of what the validators can't decide by matching (design §3.3): the cheap model,
 * little reasoning, one call per unit a learner will read (a chat message, an answer in the margin,
 * a check's reply, a lesson step). A review that fails finds nothing: it can hold a message back
 * for a rewrite, never stop one.
 */
export function createReviewer(
  models: ModelAccess,
  ids: { userId: string; trackId: string; sessionId: string },
): Reviewer {
  return async (unit) => {
    try {
      const model = await models.model({ ...ids, purpose: "wording-review", role: "cheap" });
      const issues = await reviewWording(model, unit);
      if (issues.length > 0)
        log.info(
          { flagged: unit.flagged.length, issues: issues.map((i) => i.code) },
          "the review found words to change",
        );
      return issues;
    } catch (error) {
      log.warn({ err: error }, "wording review failed; going on without it");
      return [];
    }
  };
}
