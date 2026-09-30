import { useEffect, useReducer } from "react";
import type { Assignment, Review, ReviewComment, ReviewMessage } from "@/lib/assignments";
import { followSession, type StreamEvent } from "@/lib/session-stream";

/** The review's events on the log of the session that set the assignment (api: engine/reviews.ts). */
const REVIEW_EVENT_TYPES = ["review", "review-message", "review-delta", "review-resolved"];

/** A comment as the page holds it: with the tutor's answer to a reply while it streams. */
export interface LiveComment extends ReviewComment {
  /** The answer so far, while the learner's last reply is being answered; null otherwise. */
  draft: string | null;
}

export interface LiveReview extends Omit<Review, "comments"> {
  comments: LiveComment[];
}

const live = (review: Review | null): LiveReview | null =>
  review && { ...review, comments: review.comments.map((c) => ({ ...c, draft: null })) };

/** The reply a comment's card waits on an answer to: its thread ends with the learner. */
export const waitingReply = (comment: ReviewComment) => {
  const last = comment.messages.at(-1);
  return last?.role === "learner" ? last : null;
};

/**
 * Folds one of the review's events into it. Events of the session's other assignments are left
 * out; replays may repeat events, so everything is keyed by id.
 */
export function reduceReview(
  review: LiveReview | null,
  assignmentId: string,
  event: StreamEvent,
): LiveReview | null {
  const data = event.data as Record<string, unknown>;
  if (typeof data.assignmentId === "string" && data.assignmentId !== assignmentId) return review;
  if (event.type === "review") return live(data as unknown as Review);
  if (!review) return review;
  const update = (id: unknown, change: (comment: LiveComment) => LiveComment) => ({
    ...review,
    comments: review.comments.map((c) => (c.id === id ? change(c) : c)),
  });
  switch (event.type) {
    case "review-message": {
      const message = data as unknown as ReviewMessage & { commentId: string };
      return update(message.commentId, (comment) => {
        if (comment.messages.some((m) => m.id === message.id)) return comment;
        // The answer keeps the text it streamed as, so the card finishes revealing it first.
        const text = message.role === "tutor" ? (comment.draft ?? message.text) : message.text;
        const { id, role, blocks, failure } = message;
        return {
          ...comment,
          messages: [...comment.messages, { id, role, text, blocks, failure: failure ?? null }],
          draft: null,
        };
      });
    }
    case "review-delta":
      return update(data.commentId, (comment) =>
        waitingReply(comment)?.id === data.replyTo
          ? { ...comment, draft: (comment.draft ?? "") + (data.text as string) }
          : comment,
      );
    case "review-resolved":
      return update(data.commentId, (comment) => ({
        ...comment,
        resolvedAt: (data.resolvedAt as string | null) ?? new Date().toISOString(),
      }));
    default:
      return review;
  }
}

type Action = { kind: "snapshot"; review: Review | null } | { kind: "event"; event: StreamEvent };

/**
 * The assignment's review as it arrives (design §7.4): from its page's snapshot, then live from the
 * log of the session that set it. A fresh snapshot of the page starts it again from there.
 */
export function useReview(assignment: Assignment): LiveReview | null {
  const [review, dispatch] = useReducer(
    (current: LiveReview | null, action: Action) =>
      action.kind === "snapshot"
        ? live(action.review)
        : reduceReview(current, assignment.id, action.event),
    assignment.review,
    live,
  );
  const handedIn = assignment.submittedAt !== null;
  useEffect(() => {
    dispatch({ kind: "snapshot", review: assignment.review });
    // Nothing to follow before it is handed in; the page is fetched again then.
    if (!handedIn) return;
    return followSession(
      assignment.sessionId,
      assignment.lastEventId,
      REVIEW_EVENT_TYPES,
      (event) => {
        dispatch({ kind: "event", event });
      },
    );
  }, [assignment.review, assignment.sessionId, assignment.lastEventId, handedIn]);
  return review;
}
