import type { SourceReading, SourceSectionView } from "@grounded/core/sources";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./api";

/** A source track's reading and coverage (api: track-source.ts, design §4.6). */
export interface SourceCoverage {
  reading: SourceReading;
  /** Each section of the source and where the track stands with it; none until it is read. */
  sections: SourceSectionView[];
}

/** Fresh each time the page opens: sessions move the coverage on elsewhere. */
export const sourceQuery = (trackId: string) =>
  queryOptions({
    queryKey: ["source", trackId],
    queryFn: () => api<SourceCoverage>(`/api/tracks/${trackId}/source`),
    staleTime: 0,
  });

/** Says to read the source, once the estimate is seen; or to try again after reading stopped. */
export const readSource = (trackId: string) =>
  api<null>(`/api/tracks/${trackId}/source/read`, { method: "POST" });
