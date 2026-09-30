import { and, assignments, eq, reviews, sql, type Db } from "@grounded/db";
import { log } from "../log.js";
import { jobWaiting } from "./queue.js";
import { replyFailed } from "./review-reply.js";
import { publishReview, recordReviewMessage } from "./reviews.js";
import { loadSession } from "./session-store.js";
import { unlessWorkedOn } from "./work-locks.js";

/**
 * Reviews and replies that a job which died left waiting (design §4.2), in open sessions and closed
 * ones alike: a review is often of homework handed in after its session closed. A review still under
 * way that no live job is working on and none is queued for is marked failed, so its page offers to
 * start it again; a reply still waiting is told in its card that it didn't go through. A review its
 * session waits for is left to the session's "Try again" (retry.ts), which runs it again. Only work
 * quiet for `quietForMs` is looked at: a request may be between recording it and queuing its job.
 */
export async function recoverReviews(db: Db, quietForMs: number): Promise<void> {
  const quiet = sql`now() - make_interval(secs => ${quietForMs / 1000})`;
  const stuck = await db
    .select({ review: reviews, assignment: assignments })
    .from(reviews)
    .innerJoin(assignments, eq(assignments.id, reviews.assignmentId))
    .where(and(eq(reviews.status, "reviewing"), sql`${reviews.updatedAt} < ${quiet}`));
  let failed = 0;
  for (const { review, assignment } of stuck) {
    const { state } = await loadSession(db, assignment.sessionId);
    if (
      assignment.kind === "homework" &&
      state.phase === "homework" &&
      state.homework === "reviewing"
    )
      continue;
    const marked = await unlessWorkedOn(db, assignment.sessionId, async () => {
      if (await jobWaiting(db, "review", assignment.sessionId)) return false;
      const rows = await db
        .update(reviews)
        .set({ status: "failed", failure: { code: "interrupted" } })
        .where(and(eq(reviews.id, review.id), eq(reviews.status, "reviewing")))
        .returning({ id: reviews.id });
      return rows.length > 0;
    });
    if (!marked) continue;
    await publishReview(db, assignment);
    failed++;
  }

  const waiting = await db.execute<{
    comment_id: string;
    assignment_id: string;
    session_id: string;
  }>(sql`
    select c.id as comment_id, a.id as assignment_id, a.session_id
    from review_comments c
    join reviews r on r.id = c.review_id
    join assignments a on a.id = r.assignment_id
    cross join lateral (
      select m.role, m.created_at from review_messages m
      where m.comment_id = c.id order by m.created_at desc, m.id desc limit 1
    ) last
    where c.resolved_at is null and last.role = 'learner' and last.created_at < ${quiet}`);
  let replies = 0;
  for (const row of waiting) {
    const told = await unlessWorkedOn(db, row.session_id, async () => {
      if (await jobWaiting(db, "review-reply", row.session_id, { commentId: row.comment_id }))
        return false;
      await recordReviewMessage(
        db,
        { id: row.assignment_id, sessionId: row.session_id },
        row.comment_id,
        { role: "tutor", ...replyFailed({ code: "interrupted" }) },
      );
      return true;
    });
    if (told) replies++;
  }
  if (failed || replies)
    log.warn({ reviews: failed, replies }, "recovered reviews a dead job left waiting");
}
