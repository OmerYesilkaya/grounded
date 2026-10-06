import { reviewWording, type LearnerWords, type Reviewer } from "@grounded/core";
import { and, asc, eq, isNotNull, sessionMessages, tracks, users, type Db } from "@grounded/db";
import { log } from "../log.js";
import type { ModelAccess } from "./model-call.js";

/**
 * The review of what the validators can't decide by matching (design §3.3): the cheap model,
 * little reasoning, one call per unit a learner will read (a chat message, an answer in the margin,
 * a check's reply, a lesson step). A review that fails finds nothing: it can hold a message back
 * for a rewrite, never stop one.
 */
export function createReviewer(
  db: Db,
  models: ModelAccess,
  ids: { userId: string; trackId: string; sessionId: string },
): Reviewer {
  return async (unit) => {
    try {
      const model = await models.model({ ...ids, purpose: "wording-review", role: "cheap" });
      const issues = await reviewWording(model, unit, await learnerWordsOf(db, ids));
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

/** What the learner has said so far, read fresh for each text: the last answer counts. */
async function learnerWordsOf(
  db: Db,
  ids: { trackId: string; sessionId: string },
): Promise<LearnerWords | undefined> {
  const [track] = await db
    .select({ goal: tracks.goal, brief: tracks.brief, about: users.about })
    .from(tracks)
    .innerJoin(users, eq(users.id, tracks.userId))
    .where(eq(tracks.id, ids.trackId));
  if (!track) return undefined;
  const said = await db
    .select({ text: sessionMessages.text })
    .from(sessionMessages)
    .where(
      and(
        eq(sessionMessages.sessionId, ids.sessionId),
        eq(sessionMessages.role, "learner"),
        isNotNull(sessionMessages.text),
      ),
    )
    .orderBy(asc(sessionMessages.createdAt));
  return { ...track, said: said.flatMap((m) => (m.text ? [m.text] : [])) };
}
