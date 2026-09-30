import {
  allowedBlocksLine,
  REVIEW_REPLY_RECORD_PROMPT,
  reviewRecord,
  reviewReplyRecordSchema,
  type Cause,
  type FailureNotice,
} from "@grounded/core";
import { parseBlocks, type Block } from "@grounded/content";
import { assignments, eq } from "@grounded/db";
import { generateText, Output, type ModelMessage } from "ai";
import type { Task } from "graphile-worker";
import { addLogContext, log } from "../log.js";
import { composeReply } from "./chat.js";
import { publish } from "./events.js";
import { reportHandledFailure } from "./queue.js";
import { createReviewer } from "./review.js";
import { reviewPrompt } from "./review-call.js";
import type { ReviewTaskDependencies } from "./review-tasks.js";
import {
  labelIn,
  loadReview,
  recordReviewMessage,
  resolveLeaks,
  reviewedAssignment,
  type ReviewMessageView,
} from "./reviews.js";
import { causeOf } from "./model-call.js";

interface ReplyJob {
  sessionId: string;
  assignmentId: string;
  commentId: string;
}

/**
 * The app's answer when a reply couldn't be answered, so the learner can reply again: a notice the
 * web words (design §9.3), and the same in English for the tutor's later calls.
 */
export const replyFailed = (cause: Cause | null) => {
  const text = "That didn't go through. Reply again when you're ready.";
  return {
    text,
    blocks: parseBlocks(text).blocks,
    failure: { code: "thread-failed", thread: "reply", cause } satisfies FailureNotice,
  };
};

/** The reply a comment's card waits on: its thread ends with the learner. */
export const waitingReply = (messages: readonly ReviewMessageView[]) => {
  const last = messages.at(-1);
  return last?.role === "learner" ? last : null;
};

/**
 * The answer to the learner's reply in a comment's card (design §7.4): the strong model, streamed
 * into the card, Socratic like the comment, then a small record of whether the learner has found
 * the flaw, which resolves the leak. A failed answer says so in the card.
 */
export function createReplyTask(deps: ReviewTaskDependencies): Task {
  const { db, models } = deps;
  return async (payload) => {
    const { sessionId, assignmentId, commentId } = payload as ReplyJob;
    const [assignment] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.id, assignmentId));
    if (!assignment) return;
    addLogContext({
      userId: assignment.userId,
      trackId: assignment.trackId,
      assignmentId,
      commentId,
    });
    const comment = (await loadReview(db, assignmentId))?.comments.find((c) => c.id === commentId);
    // Only a reply still waiting is answered: recovery may have answered it already.
    const reply = comment ? waitingReply(comment.messages) : null;
    if (!comment || !reply) return;
    const ids = { userId: assignment.userId, trackId: assignment.trackId, sessionId };

    let messages: ModelMessage[];
    let system: Awaited<ReturnType<typeof reviewPrompt>>["system"];
    let answer: { text: string; blocks: Block[] };
    try {
      const reviewed = await reviewedAssignment(db, assignment);
      const where = comment.anchor.quote
        ? `The learner's words «${comment.anchor.quote}» in ${labelIn(assignment, comment.anchor)}.`
        : `The learner's ${labelIn(assignment, comment.anchor)} as a whole.`;
      const prompt = await reviewPrompt({
        ...deps,
        assignment,
        extra: [
          ...(reviewed ? [{ heading: "Your review of it", body: reviewRecord(reviewed) }] : []),
          {
            heading: "The comment the learner is replying to",
            body: `${where} Go on as the comment began: Socratic, pointing at the flaw and asking, never handing over the corrected answer. A few sentences. ${allowedBlocksLine("review", "your answer")}`,
          },
        ],
      });
      system = prompt.system;
      messages = [
        prompt.opening,
        ...comment.messages.map((m): ModelMessage =>
          m.role === "learner"
            ? { role: "user", content: m.text }
            : { role: "assistant", content: m.text },
        ),
      ];
      const model = await models.model({ ...ids, purpose: "review-reply", role: "strong" });
      answer = await composeReply({
        db,
        sessionId,
        model,
        system,
        messages,
        terms: prompt.terms,
        surface: "review",
        activities: false,
        onText: async (text) => {
          await publish(db, sessionId, "review-delta", { commentId, replyTo: reply.id, text });
        },
        logFields: { commentId },
        media: deps.media,
        review: createReviewer(db, models, ids),
      });
      await recordReviewMessage(db, assignment, commentId, { role: "tutor", ...answer });
    } catch (error) {
      // Otherwise the card waits forever: say so in it, so the learner can reply again.
      const cause = causeOf(error);
      const known = cause !== null;
      await recordReviewMessage(db, assignment, commentId, {
        role: "tutor",
        ...replyFailed(cause),
      });
      if (!known) throw error;
      reportHandledFailure(error);
      return;
    }

    // Then whether the learner has found the flaw; if the record fails, the leak stays open.
    try {
      const model = await models.model({ ...ids, purpose: "review-record", role: "strong" });
      const { output } = await generateText({
        model,
        system,
        output: Output.object({ schema: reviewReplyRecordSchema }),
        messages: [
          ...messages,
          { role: "assistant", content: answer.text },
          { role: "user", content: REVIEW_REPLY_RECORD_PROMPT },
        ],
      });
      if (output.resolved) await resolveLeaks(db, [commentId], null);
    } catch (error) {
      log.warn({ err: error }, "a reply's record failed; the leak stays open");
    }
  };
}
