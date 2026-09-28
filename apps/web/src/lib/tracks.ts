import type { AttachmentKind } from "@grounded/core";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface TrackSummary {
  id: string;
  /** The track's short name; a stand-in while `naming` (design §9.5). */
  title: string;
  /** The tutor is still naming the track. */
  naming: boolean;
  language: string | null;
  openSession: { id: string; phase: string } | null;
  /** The last lesson imported from the learner's earlier setup, if any. */
  importedLesson: { title: string } | null;
  /** The files attached when the track was created (design §4.5). */
  files: TrackFile[];
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
