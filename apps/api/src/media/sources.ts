import type { CitedSource } from "@grounded/content";
import type { ResearchSource } from "@grounded/db";
import type { WebAccess } from "./web.js";

/**
 * The research's pages a lesson may cite (design §6.4): each asked about once, before the lesson is
 * written, and kept only when it opens, at the address its redirects end on (a provider may hand
 * back its own redirect, as Gemini does). Two that end on the same page are one. Without a title
 * from the provider, a page is named by its site.
 */
export async function citableSources(
  sources: readonly ResearchSource[],
  web: WebAccess,
): Promise<CitedSource[]> {
  const landed = await Promise.all(
    sources.map(async (source) => {
      const landing = await web.probe(source.url).catch(() => null);
      if (!landing || landing.status >= 400) return null;
      return { url: landing.url, title: source.title ?? siteOf(landing.url) };
    }),
  );
  const citable = new Map<string, CitedSource>();
  for (const source of landed)
    if (source && !citable.has(source.url)) citable.set(source.url, source);
  return [...citable.values()];
}

/** A page's site as a reader names it: its host, without "www.". */
function siteOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
}
