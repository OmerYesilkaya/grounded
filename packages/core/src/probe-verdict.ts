import { z } from "zod";
import type { SessionPhase } from "./session.js";

/*
 * "See where you stand" (design §7.1, #61): after a track's first probe the learner may ask what
 * it found. The verdict locates the boundary and nothing more (what they use confidently, where it
 * got shaky), in coarse bands per strand and overall, with prose: no corrections and no right
 * answers ahead of the lesson (method.md, "Probe": a probe teaches nothing), and no numeric score,
 * since a probe brackets a boundary per strand and a strand with a ceiling but no floor is not zero.
 */

/** The bands, coarsest to finest a probe can tell apart: the learner reads them as words. */
export const VERDICT_BANDS = ["solid", "working", "starting"] as const;

export type VerdictBand = (typeof VERDICT_BANDS)[number];

const band = z
  .enum(VERDICT_BANDS)
  .describe(
    "solid: used confidently, the harder questions too. working: something to build on, and a place above it where it got shaky. starting: little to build on yet.",
  );

export const probeVerdictSchema = z.object({
  strands: z
    .array(
      z.object({
        name: z
          .string()
          .describe("What the strand is about, in a few plain words the learner would use."),
        band,
        text: z
          .string()
          .describe(
            "One to three sentences to the learner: what they used confidently here, and where it got shaky, named but not answered.",
          ),
      }),
    )
    .describe("Each strand the probe covered, in the order the lesson would lean on them."),
  overall: z.object({
    band,
    text: z
      .string()
      .describe(
        "A few sentences to the learner on the whole, tied to what they want to reach: where they start from.",
      ),
  }),
});

export type ProbeVerdict = z.infer<typeof probeVerdictSchema>;

/**
 * The request for the verdict, after the probe's conversation. It speaks to the learner, so the
 * method's probe rules hold: it names where things got shaky, never what the answer is.
 */
export const PROBE_VERDICT_PROMPT = [
  "(The app: the probe is over, and the learner asked to see where they stand. Write it for them, from this probe alone: the conversation above, and what it recorded, in the app's context.)",
  "Locate the boundary and nothing more. For each strand the probe covered: what they used confidently, and where it got shaky, named in plain words. Never say what the right answer is, or why, and don't hint at it: the lesson teaches that, and a correction here spoils it, as it would in the probe.",
  "Give each strand a band (solid, working, starting), then the whole a band and a few sentences tied to what they want to reach. A strand where the probe found where it stops but not what they hold below it is not empty: say the probe didn't get below that point, and don't call it missing.",
  "If every answer missed, the whole is starting: say kindly that they are starting out, as the starting line of the way to their goal, not a list of misses, and keep the strands few.",
  "No scores, numbers or percentages. Speak to them as you, in the teaching language, warm and plain, without flattery. Plain sentences, no markdown. Name ideas in their own words or in everyday ones, not in technical terms they don't already use.",
].join("\n\n");

/** The verdict's prose as one text, for the chat's validators and wording review. */
export function verdictText(verdict: ProbeVerdict): string {
  return [
    verdict.overall.text,
    ...verdict.strands.map((strand) => `${strand.name}: ${strand.text}`),
  ].join("\n\n");
}

/** A chat message as the verdict needs it: who wrote it and of what kind. */
interface ChatTurn {
  role: "learner" | "tutor";
  kind: string;
}

/**
 * The probe's part of a session's chat: everything before the first plan. What comes after (the
 * plan, a revision asked for, the homework, the recap) is not the probe's.
 */
export function probePart<T extends ChatTurn>(messages: readonly T[]): T[] {
  const plan = messages.findIndex((m) => m.kind === "plan");
  return plan === -1 ? [...messages] : messages.slice(0, plan);
}

/** How many answers the learner gave in the probe. */
export const probeAnswers = (messages: readonly ChatTurn[]) =>
  probePart(messages).filter((m) => m.role === "learner" && m.kind === "message").length;

/** The phases a session's probe is behind in. */
const AFTER_PROBE: readonly SessionPhase[] = ["plan", "lesson", "homework", "close", "closed"];

/**
 * Whether "See where you stand" is offered (#61): after a track's first probe only (later probes
 * are narrower, and a learner mid-track needn't be reminded of what they don't know yet), once it
 * is over, and only when the learner answered at least once. A probe skipped before any answer has
 * nothing to say; one where every answer missed is still offered.
 */
export function verdictOffered(input: {
  final: boolean;
  /** The track's first session. */
  first: boolean;
  phase: SessionPhase;
  answers: number;
}): boolean {
  return !input.final && input.first && AFTER_PROBE.includes(input.phase) && input.answers > 0;
}
