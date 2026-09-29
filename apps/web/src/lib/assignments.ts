import type { Block } from "@grounded/content";
import type { Answers, ChecklistItem, TaskAnswer, TaskForm } from "@grounded/core/assignment";
import type { ChecklistMark, ReviewAnchor } from "@grounded/core/assignment-review";
import type { Snooze } from "@grounded/core/snooze";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { browserTimeZone } from "./snooze";

/** An assignment as its session's chat and snapshot know it (api: engine/assignments.ts). */
export interface AssignmentSummary {
  id: string;
  kind: "homework" | "exam";
  title: string;
  /** The chat message it was written as. */
  messageId: string;
  submittedAt: string | null;
  /** Put off with a snooze: when it is due again. */
  snoozedUntil: string | null;
  /** The later homework it was folded into, if it was. */
  subsumedBy: string | null;
}

/** An assignment in full, for its page (GET /api/assignments/:id). */
export interface Assignment {
  id: string;
  trackId: string;
  trackTitle: string;
  sessionId: string;
  /** The session that assigned it: its place in the track, and whether it waits for this. */
  session: { number: number; waiting: boolean };
  kind: "homework" | "exam";
  title: string;
  tasks: { id: string; title: string | null; form: TaskForm; blocks: Block[] }[];
  checklist: ChecklistItem[];
  answers: Answers;
  createdAt: string;
  submittedAt: string | null;
  /** Put off with a snooze: when it is due again. */
  snoozedUntil: string | null;
  /** The later homework it was folded into (method.md, "Homework"): closed, and that one covers it. */
  subsumedBy: { id: string; title: string } | null;
  /** Its review, once it is handed in. */
  review: Review | null;
  lastEventId: number;
}

/** A message of a margin comment's thread: the tutor's validated blocks, or the learner's words. */
export interface ReviewMessage {
  id: string;
  role: "learner" | "tutor";
  text: string;
  blocks: Block[] | null;
}

/** A comment in the margin of a reviewed answer, where the learner's model leaked (design §7.4). */
export interface ReviewComment {
  id: string;
  anchor: ReviewAnchor;
  /** The checklist items it bears on. */
  items: string[];
  /** When the learner found the flaw (or a later session's review settled it); null while open. */
  resolvedAt: string | null;
  /** The comment, then the replies and the tutor's answers. */
  messages: ReviewMessage[];
}

/** The review of a handed-in assignment (api: engine/reviews.ts). */
export interface Review {
  id: string;
  status: "reviewing" | "done" | "failed";
  /** Why it failed, for the learner. */
  failure: string | null;
  checklist: ChecklistMark[];
  comments: ReviewComment[];
}

export const assignmentQuery = (id: string) =>
  queryOptions({
    queryKey: ["assignment", id],
    queryFn: () => api<Assignment>(`/api/assignments/${id}`),
    staleTime: Infinity,
  });

export function useAssignment(id: string) {
  return useQuery(assignmentQuery(id));
}

const post = <T>(path: string, body?: object) =>
  api<T>(path, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });

/** The calls the homework page makes; each answers with what the server now holds. */
export const assignmentApi = {
  /** Saves one task's answer as the learner has written it so far. */
  save: (id: string, taskId: string, fields: Record<string, string>) =>
    api<TaskAnswer>(`/api/assignments/${id}/answers`, {
      method: "PUT",
      body: JSON.stringify({ taskId, fields }),
    }),
  /** Predict → verify: locks the prediction, with the time, before the learner checks it. */
  lock: (id: string, taskId: string) =>
    post<TaskAnswer>(`/api/assignments/${id}/tasks/${taskId}/lock`),
  submit: (id: string) => post<{ submittedAt: string }>(`/api/assignments/${id}/submit`),
  /** "Later": puts it off until tonight or tomorrow, in the browser's time zone. */
  later: (id: string, snooze: Snooze) =>
    post<{ snoozedUntil: string }>(`/api/assignments/${id}/later`, {
      snooze,
      timeZone: browserTimeZone(),
    }),
  /** Starts a review that failed again. */
  reviewAgain: (id: string) => post<{ reviewing: true }>(`/api/assignments/${id}/review`),
  /** A reply in a comment's card; the tutor answers it there. */
  reply: (id: string, commentId: string, text: string) =>
    post<{ id: string }>(`/api/assignments/${id}/review/comments/${commentId}/replies`, { text }),
  /** Stores a picture for an answer; the markdown links it by the URL it comes back with. */
  picture: (id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return api<{ id: string; url: string }>(`/api/assignments/${id}/files`, {
      method: "POST",
      body: form,
    });
  },
};
