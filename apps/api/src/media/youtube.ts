import { z } from "zod";
import type { WebAccess } from "./web.js";

/** What YouTube says about a video id. */
export interface VideoFacts {
  exists: boolean;
  /** Whether its owner lets other sites embed it. */
  embeddable: boolean;
  /** Its length, when known (only the Data API says). */
  durationSeconds: number | null;
}

const VIDEO_ID = /^[\w-]{11}$/;

const dataSchema = z.object({
  items: z.array(
    z.object({
      contentDetails: z.object({ duration: z.string() }).optional(),
      status: z.object({ embeddable: z.boolean().optional() }).optional(),
    }),
  ),
});

/**
 * Asks YouTube about a video. With an API key the Data API gives its length too, so start and end
 * times can be checked against it; without one (or when the Data API fails, out of quota say),
 * oEmbed says whether it exists and can be embedded.
 */
export async function videoFacts(
  web: WebAccess,
  id: string,
  apiKey: string | undefined,
): Promise<VideoFacts> {
  if (!VIDEO_ID.test(id)) return { exists: false, embeddable: false, durationSeconds: null };
  if (apiKey) {
    const facts = await fromDataApi(web, id, apiKey).catch(() => null);
    if (facts) return facts;
  }
  return fromOembed(web, id);
}

async function fromDataApi(web: WebAccess, id: string, key: string): Promise<VideoFacts | null> {
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "contentDetails,status");
  url.searchParams.set("id", id);
  url.searchParams.set("key", key);
  const { status, body } = await web.getJson(url.toString());
  const parsed = dataSchema.safeParse(body);
  if (status !== 200 || !parsed.success) return null;
  const [video] = parsed.data.items;
  if (!video) return { exists: false, embeddable: false, durationSeconds: null };
  return {
    exists: true,
    embeddable: video.status?.embeddable ?? false,
    durationSeconds: parseDuration(video.contentDetails?.duration ?? ""),
  };
}

async function fromOembed(web: WebAccess, id: string): Promise<VideoFacts> {
  const url = new URL("https://www.youtube.com/oembed");
  url.searchParams.set("format", "json");
  url.searchParams.set("url", watchUrl(id));
  const { status } = await web.getJson(url.toString());
  // 401 and 403: the video is there, but its owner doesn't allow embedding it.
  if (status === 200) return { exists: true, embeddable: true, durationSeconds: null };
  if (status === 401 || status === 403)
    return { exists: true, embeddable: false, durationSeconds: null };
  if (status === 400 || status === 404)
    return { exists: false, embeddable: false, durationSeconds: null };
  throw new Error(`YouTube answered ${String(status)}`);
}

export function watchUrl(id: string, start: number | null = null): string {
  const url = new URL("https://www.youtube.com/watch");
  url.searchParams.set("v", id);
  if (start) url.searchParams.set("t", `${String(Math.floor(start))}s`);
  return url.toString();
}

/** An ISO 8601 duration ("PT1H2M3S") in seconds; null for none (a live stream has "P0D"). */
export function parseDuration(value: string): number | null {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!match) return null;
  const [days, hours, minutes, seconds] = match
    .slice(1)
    // An unmatched group is undefined at runtime, though typed as a string.
    .map((part: string | undefined) => Number(part ?? 0));
  const total = (days ?? 0) * 86400 + (hours ?? 0) * 3600 + (minutes ?? 0) * 60 + (seconds ?? 0);
  return total > 0 ? total : null;
}
