import type { AttachmentKind } from "@grounded/core/attachments";
import type { SessionPhase, TaskForm } from "@grounded/core";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface TrackSummary {
  id: string;
  /** The track's short name; a stand-in while `naming` (design §9.5). */
  title: string;
  /** The tutor is still naming the track. */
  naming: boolean;
  language: string | null;
  /** The latest activity on the track or anything in it; the list comes ordered by it. */
  activeAt: string;
  /** What is inside the track, oldest first (design §9.2). */
  items: TrackItem[];
  openSession: { id: string; phase: SessionPhase } | null;
  /** The last lesson imported from the learner's earlier setup, if any. */
  importedLesson: { title: string } | null;
  /** The files attached when the track was created (design §4.5). */
  files: TrackFile[];
}

/**
 * Something inside a track (api: track-list.ts). Every kind has an id, `done` and `activeAt`; each
 * adds what its row says. Sessions and their homework; arc exams join as a kind (#42).
 */
export type TrackItem = SessionItem | HomeworkItem;

export interface SessionItem {
  kind: "session";
  id: string;
  done: boolean;
  activeAt: string;
  /** The session's place in the track, from 1. */
  number: number;
  phase: SessionPhase;
  /** The terms its lesson introduces, in order; none until the lesson is outlined. */
  terms: string[];
  /** The lesson's title; null until it is outlined (and for a lesson outlined before titles). */
  lessonTitle: string | null;
}

/**
 * A session's homework, listed after it: open (not `done`) until it is handed in or folded into a
 * later homework.
 */
export interface HomeworkItem {
  kind: "homework";
  id: string;
  done: boolean;
  activeAt: string;
  /** The number of the session that assigned it. */
  session: number;
  /** A few words naming it. */
  title: string;
  form: TaskForm;
  /** Put off with a snooze: when it is due again, for its tag (design §9.2); null otherwise. */
  due: string | null;
  /** Folded into a later homework: the number of the session that assigned that one. */
  foldedInto: number | null;
}

/** Homework whose snooze has run out: due now (design §9.2, "1 due"). */
export const isDue = (item: TrackItem, now: Date): item is HomeworkItem & { due: string } =>
  item.kind === "homework" && !item.done && item.due !== null && new Date(item.due) <= now;

export interface TrackFile {
  id: string;
  name: string;
  kind: AttachmentKind;
  sizeBytes: number;
}

/** The learner's tracks; checked again every second while the tutor is naming one. */
export const tracksQuery = queryOptions({
  queryKey: ["tracks"],
  queryFn: () => api<TrackSummary[]>("/api/tracks"),
  refetchInterval: (query) => (query.state.data?.some((t) => t.naming) ? 1000 : false),
});

export function useTracks() {
  return useQuery(tracksQuery);
}
