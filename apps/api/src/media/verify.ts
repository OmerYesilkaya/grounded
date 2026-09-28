import type { Block, Inline, Issue } from "@grounded/content";
import { lookupCommons, titleOf, type CommonsCandidate, type CommonsKind } from "./commons.js";
import type { WebAccess } from "./web.js";
import { videoFacts, watchUrl, type VideoFacts } from "./youtube.js";

export interface VerifierOptions {
  web: WebAccess;
  /** YouTube Data API key: with it, a clip's start and end are checked against the video's length. */
  youtubeKey?: string | undefined;
}

export interface Verified {
  blocks: Block[];
  /** One per thing left out or changed, degradable ("image/…", "video/…", "link/…", "chart/…"). */
  issues: Issue[];
}

/**
 * Resolves every URL a block tree shows before the learner sees it (design §6.4): Commons images
 * and recordings (the block gets the file it names), YouTube clips, link cards, inline links and a
 * chart's source. What can't be verified is left out: a missing file, video or page is dropped, an
 * inline link keeps its text, a video that exists but can't be shown as asked becomes a link card.
 *
 * Each answer is remembered for the verifier's life (one lesson, one message), so a URL used twice,
 * or again in a rewrite, is asked about once; nothing outlives it, since what it verified is stored
 * with the content.
 */
export function createVerifier(options: VerifierOptions) {
  const { web } = options;
  const files = new Map<string, Promise<CommonsCandidate | null>>();
  const videos = new Map<string, Promise<VideoFacts | null>>();
  const pages = new Map<string, Promise<number | null>>();

  const remembered = <T>(memo: Map<string, Promise<T>>, key: string, ask: () => Promise<T>) => {
    let answer = memo.get(key);
    if (!answer) {
      answer = ask();
      memo.set(key, answer);
    }
    return answer;
  };

  const file = (kind: CommonsKind, ref: string) =>
    remembered(files, `${kind} ${titleOf(ref) ?? ref}`, () =>
      lookupCommons(web, kind, ref).catch(() => null),
    );
  const video = (id: string) =>
    remembered(videos, id, () => videoFacts(web, id, options.youtubeKey).catch(() => null));
  /** The status a page ends on, or null when it can't be reached. */
  const page = (url: string) => remembered(pages, url, () => web.probe(url).catch(() => null));

  return {
    /** A file the lesson's tools already found, so verifying its ref asks nothing more. */
    know(found: CommonsCandidate): void {
      files.set(`${found.kind} ${titleOf(found.ref) ?? found.ref}`, Promise.resolve(found));
    },

    async verify(blocks: readonly Block[], where: { stepId?: string } = {}): Promise<Verified> {
      // Everything is asked about at once; each block and link takes its place in document order
      // as it is visited, so its issues are reported in that order, however the answers arrive.
      const issues: { order: number; issue: Issue }[] = [];
      let visited = 0;
      const reporter = () => {
        const order = visited++;
        return (code: string, message: string, blockId: string) => {
          issues.push({ order, issue: { code, message, blockId, ...where } });
        };
      };

      const inlines = async (list: readonly Inline[], blockId: string): Promise<Inline[]> =>
        (
          await Promise.all(
            list.map(async (inline): Promise<Inline[]> => {
              if (inline.type === "strong" || inline.type === "emphasis")
                return [{ ...inline, children: await inlines(inline.children, blockId) }];
              if (inline.type !== "link") return [inline];
              const report = reporter();
              const children = await inlines(inline.children, blockId);
              const status = await page(inline.url);
              if (opens(status)) return [{ ...inline, children }];
              report("link/unverified", linkMessage(inline.url, status), blockId);
              return children;
            }),
          )
        ).flat();

      const many = async (list: readonly Block[]): Promise<Block[]> =>
        (await Promise.all(list.map(one))).filter((b): b is Block => b !== null);

      const one = async (block: Block): Promise<Block | null> => {
        const report = reporter();
        switch (block.type) {
          case "heading":
          case "paragraph":
            return { ...block, children: await inlines(block.children, block.id) };
          case "list":
            return { ...block, items: await Promise.all(block.items.map(many)) };
          case "quote":
          case "check":
            return { ...block, children: await many(block.children) };
          case "table":
            return {
              ...block,
              header: await Promise.all(block.header.map((cell) => inlines(cell, block.id))),
              rows: await Promise.all(
                block.rows.map((row) => Promise.all(row.map((cell) => inlines(cell, block.id)))),
              ),
            };
          case "image":
          case "audio": {
            const found = await file(block.type, block.ref);
            if (found) return { ...block, file: found.file };
            report(
              `${block.type}/unverified`,
              `"${block.ref}" isn't a file on Wikimedia Commons that can be shown here. Use a ref find_${block.type} returned, exactly as given, or leave the ${block.type} out.`,
              block.id,
            );
            return null;
          }
          case "video": {
            const facts = await video(block.videoId);
            if (!facts?.exists) {
              report(
                "video/unverified",
                facts
                  ? `There is no YouTube video "${block.videoId}" (or it is private). Use a video from your search results, or leave it out.`
                  : `YouTube didn't answer about the video "${block.videoId}". Use a video from your search results, or leave it out.`,
                block.id,
              );
              return null;
            }
            const problem = !facts.embeddable
              ? `The YouTube video "${block.videoId}" can't be shown inside the lesson: its owner doesn't allow it.`
              : timesProblem(block, facts.durationSeconds);
            if (!problem) return block;
            report("video/unverified", `${problem} Use another video, or leave it out.`, block.id);
            return {
              id: block.id,
              type: "link",
              url: watchUrl(block.videoId, block.start),
              title: "Watch on YouTube",
              why: block.caption ?? "The video this step points to.",
            };
          }
          case "link": {
            const status = await page(block.url);
            if (opens(status)) return block;
            report("link/unverified", linkMessage(block.url, status), block.id);
            return null;
          }
          case "chart": {
            // A source that isn't a web address is shown as text, not as a link.
            if (!block.source || !/^https?:\/\//i.test(block.source)) return block;
            const status = await page(block.source);
            if (opens(status)) return block;
            report(
              "chart/unverified-source",
              `The chart's source ${notOpening(block.source, status)}. Give the address of the page its data comes from, or leave the source out.`,
              block.id,
            );
            return { ...block, source: null };
          }
          default:
            return block;
        }
      };

      const verified = await many(blocks);
      return {
        blocks: verified,
        issues: issues.sort((a, b) => a.order - b.order).map(({ issue }) => issue),
      };
    },
  };
}

export type Verifier = ReturnType<typeof createVerifier>;

const opens = (status: number | null): boolean => status !== null && status < 400;

function notOpening(url: string, status: number | null): string {
  const why = status === null ? "couldn't be reached" : `answered ${String(status)}`;
  return `${url} doesn't open (it ${why})`;
}

const linkMessage = (url: string, status: number | null) =>
  `The link ${notOpening(url, status)}. Link only to pages from your search results, or leave the link out.`;

function timesProblem(
  block: Extract<Block, { type: "video" }>,
  duration: number | null,
): string | null {
  const { start, end } = block;
  if (start !== null && end !== null && end <= start)
    return `The video's end (${String(end)} s) must come after its start (${String(start)} s).`;
  if (duration === null) return null;
  if ((start ?? 0) >= duration || (end !== null && end > duration + 1))
    return `The video "${block.videoId}" is ${String(duration)} s long; its start and end must fall inside it.`;
  return null;
}
