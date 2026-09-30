import type { ProbeVerdict } from "@grounded/core/probe-verdict";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./api";
import type { Standing, TermMap } from "./term-map";

/** An idea the learner owns or is still settling (api: track-progress.ts). */
export interface Idea {
  term: string;
  standing: Exclude<Standing, "coming">;
  /** They held it before the track taught it. */
  brought: boolean;
  /** The track a borrowed idea is held in. */
  from?: string;
  restsOn: string[];
  since: string;
  /** The learner's words that showed where it stands, as the tutor recorded them. */
  evidence: string;
  session: { id: string; number: number } | null;
}

export interface TrackProgress {
  owned: Idea[];
  settling: Idea[];
  coming: number;
  revisit: string[];
  /** "Where you started": the verdict on the track's first probe, once written (design §7.1). */
  started: { sessionId: string; verdict: ProbeVerdict } | null;
  arcs: {
    title: string;
    current: boolean;
    counts: Record<Standing, number>;
    map: TermMap;
  }[];
}

export const progressQuery = (trackId: string) =>
  queryOptions({
    queryKey: ["progress", trackId],
    queryFn: () => api<TrackProgress>(`/api/tracks/${trackId}/progress`),
    // Fresh each time the page opens: a session moves it on elsewhere.
    staleTime: 0,
  });
