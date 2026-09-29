import { describe, expect, it } from "vitest";
import type { Review } from "@/lib/assignments";
import { reduceReview, type LiveReview } from "./use-review";

const REVIEW: Review = {
  id: "r1",
  status: "done",
  failure: null,
  checklist: [{ id: "c1", mark: "leaked", note: "" }],
  comments: [
    {
      id: "k1",
      anchor: { taskId: "t1", field: "text", quote: "one step", prefix: "", suffix: "" },
      items: ["c1"],
      resolvedAt: null,
      messages: [{ id: "m1", role: "tutor", text: "What happens first?", blocks: null }],
    },
  ],
};

const live: LiveReview = {
  ...REVIEW,
  comments: REVIEW.comments.map((c) => ({ ...c, draft: null })),
};
let id = 0;
const event = (type: string, data: object) => ({ type, id: ++id, data });

describe("reduceReview", () => {
  it("takes a whole review as it now is, and leaves other assignments' events out", () => {
    const started = reduceReview(null, "a1", event("review", { assignmentId: "a1", ...REVIEW }));
    expect(started?.comments[0]?.draft).toBeNull();
    const other = event("review", { assignmentId: "a2", ...REVIEW, status: "failed" });
    expect(reduceReview(started, "a1", other)).toBe(started);
  });

  it("streams the answer to a reply, keeps its streamed text, and marks the leak resolved", () => {
    const reply = { id: "m2", role: "learner", text: "It reads.", blocks: null };
    let review = reduceReview(
      live,
      "a1",
      event("review-message", { assignmentId: "a1", commentId: "k1", ...reply }),
    );
    review = reduceReview(
      review,
      "a1",
      event("review-delta", { commentId: "k1", replyTo: "m2", text: "And " }),
    );
    review = reduceReview(
      review,
      "a1",
      event("review-delta", { commentId: "k1", replyTo: "m2", text: "then?" }),
    );
    expect(review?.comments[0]?.draft).toBe("And then?");
    const answer = { id: "m3", role: "tutor", text: "And then?", blocks: [] };
    const message = event("review-message", { assignmentId: "a1", commentId: "k1", ...answer });
    review = reduceReview(review, "a1", message);
    // A replay repeats it: nothing changes.
    review = reduceReview(review, "a1", message);
    expect(review?.comments[0]?.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(review?.comments[0]?.draft).toBeNull();
    const resolvedAt = "2026-09-29T10:00:00.000Z";
    review = reduceReview(
      review,
      "a1",
      event("review-resolved", { assignmentId: "a1", commentId: "k1", resolvedAt }),
    );
    expect(review?.comments[0]?.resolvedAt).toBe(resolvedAt);
  });
});
