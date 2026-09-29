import type { TrackAction } from "@grounded/core";
import type { Db } from "@grounded/db";
import { log } from "../log.js";
import { withActivity } from "./events.js";
import { applyValidActions, type RejectedAction } from "./track-state.js";

/** What a call hears about its rejected track edits, to send them again corrected. */
export const rejectedFeedback = (rejected: readonly RejectedAction[]) =>
  [
    "(For the app; the learner doesn't see this.) Some of your track edits were rejected and not recorded; the others were recorded:",
    ...rejected.map((r) => `- ${JSON.stringify(r.action)}: ${r.reason}`),
    "Send these edits again, corrected, and only these. Leave out any that shouldn't be made after all.",
  ].join("\n");

/**
 * Records the track edits a call made alongside its real work (the probe's decision, a check's
 * verdict, a review; design §5): what validates is applied, and what doesn't goes back to the call
 * once, with the reasons, and what validates of its answer is applied too. Asking again is
 * best-effort: if it fails, what was applied stands and the rest is left out (logged).
 */
export async function recordEdits(
  db: Db,
  options: {
    sessionId: string;
    trackId: string;
    actions: readonly TrackAction[];
    source: string;
    /** The activity the call's own work showed. */
    label: string;
    /** Asks the call again, with the rejected edits and why; returns the edits it sends instead. */
    askAgain: (feedback: string) => Promise<readonly TrackAction[]>;
  },
): Promise<void> {
  const { trackId, source } = options;
  const { rejected } = await applyValidActions(db, trackId, options.actions, { source });
  if (rejected.length === 0) return;
  log.info({ source, rejected: rejected.length }, "track edits rejected; asking again");
  try {
    const again = await withActivity(db, options.sessionId, options.label, () =>
      options.askAgain(rejectedFeedback(rejected)),
    );
    const still = again.length
      ? (await applyValidActions(db, trackId, again, { source })).rejected
      : [];
    if (still.length > 0)
      log.warn({ source, codes: still.map((r) => r.code) }, "track edits rejected again; left out");
  } catch (error) {
    log.warn({ source, err: error }, "asking again for rejected track edits failed; left out");
  }
}
