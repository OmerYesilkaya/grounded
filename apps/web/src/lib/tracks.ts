import type { AttachmentKind } from "@grounded/core/attachments";
import type { SessionPhase } from "@grounded/core";
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
 * adds what its row says. Sessions only, for now; homework and arc exams join as kinds.
 */
export type TrackItem = SessionItem;

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
}

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
