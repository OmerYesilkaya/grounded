import type { LanguageModelV4 } from "@ai-sdk/provider";
import { generateText, Output } from "ai";
import { z } from "zod";
import type { Persona } from "./persona.js";

/*
 * The judge scores a transcript against a fixed rubric, and reads the persona's sheet as the truth
 * about the learner: that is what lets it say whether the probe found the level. The rubric is its own
 * text, not method.md, so the same judge can compare two versions of the method.
 */

export const CRITERIA = {
  "probe-teaches-nothing":
    "The probe teaches nothing: no explanation, correction, confirmation or hint in the tutor's probe messages (neutral acknowledgement only).",
  "probe-one-question": "Each probe message asks one question.",
  "probe-locates-level":
    "For each strand the lesson leans on, the probe found something the learner holds before treating the strand as empty: a miss on a hard question was followed by an easier one beneath it, unless everything missed.",
  "probe-asks-goal":
    "The probe asked about the learner's goal at least once (what reaching it would let them do, which part matters most, which account they want), beyond the goal typed at the start.",
  "summary-matches-learner":
    "The probe's hidden summary matches the persona sheet: nothing the learner knows is recorded as missing or at zero, nothing they lack as held, and each misconception the probe met is noted.",
  "plan-level-fits":
    "The plan and the lesson don't set out to teach what the persona already holds (their everyday adult tools included), and don't skip what they lack.",
  "plan-previews-nothing":
    "The plan sketches the route without teaching: no explanations, worked steps or 'and the reason is…'.",
  "first-session-reaches-goal":
    "The first session reaches something the learner came for, or ends visibly one step from it, rather than spending the session on groundwork.",
  "lesson-grounded":
    "Every lesson step is motivated and rests only on what the learner holds or the lesson has taught; nothing has to be taken on faith, and no term is used before it is explained.",
  "misconceptions-dislodged":
    "Each misconception on the persona sheet that the session touched was dislodged (shown why it can't be right), not topped up or left standing. Not applicable if none was touched.",
  "checks-graded-right":
    "Every check verdict fits the answer: landed where the answer showed the idea, missed where it didn't.",
  "no-unkeepable-promises":
    "The tutor never promises what the app can't do, such as changing a lesson that is already written ('I'll go faster from here').",
  "already-held-heard":
    "When the learner said they already knew something, what came after took it into account (the reply, later checks, the homework, the recap, where you left off). Not applicable if they never said so.",
  "homework-applies":
    "The homework asks the learner to apply the session's ideas to something new, not to recall them.",
} as const;

export type CriterionId = keyof typeof CRITERIA;
const ids = Object.keys(CRITERIA) as [CriterionId, ...CriterionId[]];

export const judgementSchema = z.object({
  criteria: z
    .array(
      z.object({
        id: z.enum(ids),
        verdict: z.enum(["pass", "fail", "n/a"]),
        /** A short quote or pointer into the transcript, and why. */
        evidence: z.string(),
      }),
    )
    .describe("One entry for every criterion, in the order given."),
  checks: z
    .array(
      z.object({
        step: z.string().describe("The step id the check ends, e.g. s3."),
        question: z.string(),
        usesTheIdea: z
          .boolean()
          .describe(
            "The question makes the learner apply, predict or explain, on a case the lesson didn't work through.",
          ),
        answerableFromText: z
          .boolean()
          .describe(
            "The answer is a sentence of the lesson, a caption of its drawing, or a sum it already did.",
          ),
        verdictRight: z
          .boolean()
          .describe("The tutor's verdict on the learner's answer was right."),
        comment: z.string(),
      }),
    )
    .describe("Every check the lesson asked, in order."),
  factualErrors: z
    .array(z.object({ claim: z.string(), correction: z.string() }))
    .describe("Claims the tutor made that are wrong or misleading; empty if none."),
  summary: z.string().describe("Three sentences at most: the run's biggest strength and weakness."),
});

export type Judgement = z.infer<typeof judgementSchema>;

export async function judge(
  model: LanguageModelV4,
  persona: Persona,
  transcript: string,
): Promise<Judgement> {
  const rubric = Object.entries(CRITERIA)
    .map(([id, text]) => `- ${id}: ${text}`)
    .join("\n");
  const { output } = await generateText({
    model,
    system:
      "You review transcripts of an AI tutor's sessions, strictly and fairly. You are given the truth about the learner (a persona sheet a simulator played) and the whole session, including what the app kept hidden from the learner. Judge only from the transcript; quote it as evidence. Mark a criterion n/a only when the session never gave it a chance to apply.",
    output: Output.object({ schema: judgementSchema }),
    prompt: `# The learner (the truth)\n\n${persona.sheet}\n\n# The rubric\n\n${rubric}\n\n# The session\n\n${transcript}`,
  });
  return output;
}
