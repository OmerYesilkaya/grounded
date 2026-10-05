import type { NextReading, SourceChapterView, SourceReading } from "@grounded/core/sources";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./api";

/** A source track's reading progress (api: track-source.ts, design §4.6). */
export interface SourceProgress {
  reading: SourceReading;
  /** Each chapter of the source and where the learner stands with it; none until it is read. */
  chapters: SourceChapterView[];
  /** The chapter to read next; null before the source is read and once every chapter is read. */
  next: NextReading | null;
}

/** Fresh each time the page opens: sessions move the reading on elsewhere. */
export const sourceQuery = (trackId: string) =>
  queryOptions({
    queryKey: ["source", trackId],
    queryFn: () => api<SourceProgress>(`/api/tracks/${trackId}/source`),
    staleTime: 0,
  });

/** Says to read the source, once the estimate is seen; or to try again after reading stopped. */
export const readSource = (trackId: string) =>
  api<null>(`/api/tracks/${trackId}/source/read`, { method: "POST" });
