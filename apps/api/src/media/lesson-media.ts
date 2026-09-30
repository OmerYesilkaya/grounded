import type { CheckBlock, Inline } from "@grounded/content";
import type { LessonMedia, ActivityNotice } from "@grounded/core";
import { tool } from "ai";
import { z } from "zod";
import { log } from "../log.js";
import { searchCommons, type CommonsCandidate, type CommonsKind } from "./commons.js";
import { createVerifier, type VerifierOptions } from "./verify.js";

export interface LessonMediaOptions extends VerifierOptions {
  /** Runs a search under an activity the learner sees ("Looking for an image of …"). */
  activity?: <T>(label: ActivityNotice, run: () => Promise<T>) => Promise<T>;
}

const queryInput = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "What it should show or sound like, in a few words; Commons is searched best in English.",
    ),
});

/**
 * One lesson's media (design §6.2, §6.4): find_image and find_audio search Wikimedia Commons for
 * the outline, what they find is listed for the writer, and every step's media and links are
 * verified before the learner sees it.
 */
export function createLessonMedia(options: LessonMediaOptions): LessonMedia {
  const verifier = createVerifier(options);
  const found = new Map<string, CommonsCandidate & { query: string }>();
  const activity = options.activity ?? ((_label, run) => run());

  const find = (kind: CommonsKind) =>
    tool({
      description:
        kind === "image"
          ? "Search Wikimedia Commons for an image: a photo of the thing itself, a drawing, a historical document or map. Returns up to six files, each with its ref, what its page says it shows, its size and licence."
          : "Search Wikimedia Commons for a recording: an instrument, a piece of music, a spoken word, a sound. Returns up to six files, each with its ref, what its page says it is, its length and licence.",
      inputSchema: queryInput,
      execute: async ({ query }) => {
        try {
          const results = await activity({ code: "finding-media", kind, query }, () =>
            searchCommons(options.web, kind, query),
          );
          for (const result of results) {
            found.set(result.ref, { ...result, query });
            verifier.know(result);
          }
          return {
            files: results.map((r) => ({
              ref: r.ref,
              shows: r.description,
              size: r.size,
              license: r.file.license,
            })),
          };
        } catch (error) {
          log.warn({ kind, err: error }, "Commons search failed");
          return { files: [], note: "Wikimedia Commons didn't answer; go on without it." };
        }
      },
    });

  return {
    tools: {
      find_image: find("image"),
      find_audio: find("audio"),
    },
    found() {
      if (found.size === 0) return "";
      const lines = [...found.values()].map(
        (f) =>
          `- ${f.kind} \`${f.ref}\` (${f.size}): ${f.description || "no description"} (found for “${f.query}”)`,
      );
      return [
        'Images and recordings found on Wikimedia Commons for this lesson. Use one only where it shows what a step needs, with its ref exactly as given (`::image{ref="…" caption="…"}`, `::audio{ref="…" caption="…"}`); the app adds its credit and licence.',
        ...lines,
      ].join("\n");
    },
    async verify(step) {
      const heading = {
        id: `${step.id}.b1`,
        type: "heading" as const,
        depth: 2,
        children: step.heading,
      };
      const blocks = step.check ? [heading, ...step.body, step.check] : [heading, ...step.body];
      const verified = await verifier.verify(blocks, { stepId: step.id });
      const [first, ...rest] = verified.blocks;
      const last = rest.at(-1);
      const check: CheckBlock | null = step.check && last?.type === "check" ? last : null;
      const headingInlines: Inline[] = first?.type === "heading" ? first.children : step.heading;
      return {
        step: {
          ...step,
          heading: headingInlines,
          body: check ? rest.slice(0, -1) : rest,
          check,
        },
        issues: verified.issues,
      };
    },
  };
}
