import {
  assignmentReviewSchema,
  REVIEW_REQUEST,
  trackActionsSchema,
  type AssignmentReview,
  type Method,
} from "@grounded/core";
import {
  and,
  assignments,
  eq,
  reviewComments,
  reviewMessages,
  reviews,
  type Db,
} from "@grounded/db";
import { generateText, Output, type ModelMessage } from "ai";
import type { Task, TaskList } from "graphile-worker";
import type { FileStore } from "../files/store.js";
import { addLogContext, log } from "../log.js";
import { withVerifiedLinks, type VerifierOptions } from "../media/verify.js";
import { assignmentOf, closeAfterReview, type AssignmentRow } from "./assignments.js";
import { traced, verdictIssues } from "./call-trace.js";
import { withActivity } from "./events.js";
import { NoCredentialError, ProviderCallError, type ModelAccess } from "./model-call.js";
import { reportHandledFailure, type JobQueue } from "./queue.js";
import { afterTakenUpReview } from "./opening-review.js";
import { createReviewer } from "./review.js";
import { reviewPrompt, settleReview, type SettledReview } from "./review-call.js";
import { createReplyTask } from "./review-reply.js";
import { publishReview } from "./reviews.js";
import { recordEdits } from "./track-edits.js";

export interface ReviewTaskDependencies {
  db: Db;
  models: ModelAccess;
  method: Method;
  queue: JobQueue;
  files: FileStore;
  /** Where a comment's links are verified (design §6.4). */
  media: VerifierOptions;
}

interface ReviewJob {
  /** The session that set the assignment: the review's events go on its log. */
  sessionId: string;
  /** Missing when the session's "Try again" queued it: the session's homework then. */
  assignmentId?: string;
}

/** What the learner reads when a review failed for a reason on our side. */
const REVIEW_FAILED = "The review didn't go through because of a problem on our side.";

/**
 * The review's jobs (design §7.4): the review of a handed-in assignment, by the strong model, and
 * the answer to a reply in a comment's card. A session that waits for its homework's review goes on
 * to its close once the review is done or has failed.
 */
export function createReviewTasks(deps: ReviewTaskDependencies): TaskList {
  const { db, models, queue } = deps;

  const assignmentFor = async (job: ReviewJob): Promise<AssignmentRow | null> => {
    if (!job.assignmentId) return assignmentOf(db, job.sessionId, "homework");
    const [row] = await db.select().from(assignments).where(eq(assignments.id, job.assignmentId));
    return row ?? null;
  };

  /** Reviews the assignment and keeps what the review found, then records its term changes. */
  const runReview = async (assignment: AssignmentRow, reviewId: string) => {
    const ids = {
      userId: assignment.userId,
      trackId: assignment.trackId,
      sessionId: assignment.sessionId,
    };
    const { system, opening, answers, terms } = await reviewPrompt({ ...deps, assignment });
    const model = await models.model({ ...ids, purpose: "review", role: "strong" });
    const label =
      assignment.kind === "exam" ? "Reviewing your arc exam" : "Reviewing your homework";
    const asking: ModelMessage[] = [opening, { role: "user", content: REVIEW_REQUEST }];
    // Traced, so each review's verdict is stored on its call (call-trace.ts).
    const ask = (feedback: ModelMessage[]) =>
      traced(() =>
        withActivity(db, assignment.sessionId, label, async () => {
          const { output } = await generateText({
            model,
            system,
            output: Output.object({ schema: assignmentReviewSchema }),
            messages: [...asking, ...feedback],
          });
          return output;
        }),
      );

    const review = createReviewer(db, models, ids);
    const settle = (output: AssignmentReview) =>
      settleReview({ output, assignment, answers, terms, review });

    const asked = await ask([]);
    // The call whose review is kept: its track edits' verdict goes on it too.
    let judge = asked.judge;
    let output = asked.value;
    let settled = await settle(output);
    await asked.judge({ rewrite: 0, issues: verdictIssues(settled.problems) });
    if (settled.problems.length > 0) {
      log.info({ problems: settled.problems.length }, "review broke rules; asking again");
      const first = output;
      const again = await ask([
        { role: "assistant", content: JSON.stringify(first) },
        {
          role: "user",
          content: `That review broke these rules; send it again, fixed:\n${settled.problems.map((p) => `- ${p}`).join("\n")}`,
        },
      ]);
      output = again.value;
      judge = again.judge;
      settled = await settle(output);
      await again.judge({ rewrite: 1, issues: verdictIssues(settled.problems) });
      if (settled.problems.length > 0)
        log.warn({ problems: settled.problems.length }, "review still breaks rules; keeping it");
    }
    await keepReview(reviewId, settled);
    await publishReview(db, assignment);

    // Term changes from how the learner used the terms (method.md, "Review").
    if (output.actions.length > 0) {
      const reviewed = output;
      await recordEdits(db, {
        sessionId: assignment.sessionId,
        trackId: assignment.trackId,
        actions: reviewed.actions,
        source: assignment.kind === "exam" ? "exam" : "homework",
        label,
        judge,
        askAgain: async (feedback) =>
          (
            await generateText({
              model,
              system,
              output: Output.object({ schema: trackActionsSchema }),
              messages: [
                ...asking,
                { role: "assistant", content: JSON.stringify(reviewed) },
                { role: "user", content: feedback },
              ],
            })
          ).output.actions,
      });
    }
  };

  /** Writes the review's comments (again, after a job that died writing them) and marks it done. */
  const keepReview = async (reviewId: string, settled: SettledReview) => {
    const comments = await Promise.all(
      settled.comments.map(async (c) => ({
        ...c,
        blocks: await withVerifiedLinks(c.blocks, deps.media),
      })),
    );
    await db.transaction(async (tx) => {
      await tx.delete(reviewComments).where(eq(reviewComments.reviewId, reviewId));
      for (const [position, comment] of comments.entries()) {
        const [row] = await tx
          .insert(reviewComments)
          .values({ reviewId, position, anchor: comment.anchor, items: comment.items })
          .returning({ id: reviewComments.id });
        if (!row) throw new Error("review comment insert returned nothing");
        await tx
          .insert(reviewMessages)
          .values({ commentId: row.id, role: "tutor", text: comment.text, blocks: comment.blocks });
      }
      await tx
        .update(reviews)
        .set({ status: "done", checklist: settled.marks, failure: null, reviewedAt: new Date() })
        .where(eq(reviews.id, reviewId));
    });
  };

  const review: Task = async (payload) => {
    const job = payload as ReviewJob;
    const assignment = await assignmentFor(job);
    if (!assignment) return;
    addLogContext({
      userId: assignment.userId,
      trackId: assignment.trackId,
      assignmentId: assignment.id,
    });
    const [row] = await db.select().from(reviews).where(eq(reviews.assignmentId, assignment.id));
    // Only a review under way is run: one done, or failed and not started again, stands.
    if (row?.status === "reviewing") {
      try {
        await runReview(assignment, row.id);
      } catch (error) {
        const known = error instanceof ProviderCallError || error instanceof NoCredentialError;
        // A review kept before the failure (in recording its term changes) stays kept.
        await db
          .update(reviews)
          .set({ status: "failed", failure: known ? error.message : REVIEW_FAILED })
          .where(and(eq(reviews.id, row.id), eq(reviews.status, "reviewing")));
        await publishReview(db, assignment);
        // The session doesn't wait for a review that failed: it can be started again from the page.
        await closeAfterReview(db, queue, assignment);
        await afterTakenUpReview(db, queue, assignment.id);
        if (!known) throw error;
        reportHandledFailure(error);
        return;
      }
    }
    await closeAfterReview(db, queue, assignment);
    // A later session's review may be waiting for this one (design §7.1).
    await afterTakenUpReview(db, queue, assignment.id);
  };

  return { review, "review-reply": createReplyTask(deps) };
}
