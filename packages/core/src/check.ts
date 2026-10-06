import type { Issue } from "@grounded/content";
import { z } from "zod";
import { trackActionSchema } from "./actions.js";

/**
 * The three ways a check's answer can be judged (method.md, "Checks inside the lesson"): it showed
 * the idea is held, it showed nothing either way (it repeats the question or the step's words, or
 * names the idea without using it), or it showed a piece is missing. Unproven is asked once per
 * check: the step stays open with a fresh question, and the next answer is decided (design §7.3).
 */
export const CHECK_VERDICTS = ["landed", "unproven", "missed"] as const;
export type CheckOutcome = (typeof CHECK_VERDICTS)[number];

/**
 * What the model returns when it grades a check. Every key is required (null when unused): strict
 * structured outputs reject optional properties. `verdicts` is what it may decide: all three, or
 * landed and missed alone once the learner was already asked to show more on this step.
 */
const checkVerdictSchemaOf = <const V extends readonly [CheckOutcome, ...CheckOutcome[]]>(
  verdicts: V,
) => {
  const unproven = verdicts.includes("unproven");
  return z.object({
    verdict: z.enum(verdicts),
    /**
     * Landed: a few words. Unproven: what the answer hasn't shown, in a few words, no explanation.
     * Missed: the repair of that one piece. The app shows it and the fresh question as one tutor
     * message, or the repair alone when it withholds the question (design §7.3).
     */
    reply: z
      .string()
      .min(1)
      .describe(
        [
          "Landed: a few words.",
          unproven
            ? "Unproven: a few words on what the answer hasn't shown yet, with no explanation."
            : "",
          "Missed: the repair of the one piece that leaked, rebuilt from what it rests on. When you give a freshQuestion, the reply asks nothing: it ends without a question, and the app shows the freshQuestion right after it, in the same message.",
        ]
          .filter(Boolean)
          .join(" "),
      ),
    /**
     * Unproven, or missed and still repairing: a fresh question on the same idea, never the same
     * question; else null.
     */
    freshQuestion: z
      .string()
      .nullable()
      .describe(
        unproven
          ? "Unproven, or missed and still repairing: the fresh question on the same idea, never the same question again; unproven, one that makes them use the idea. It is asked here only, not in the reply. Else null."
          : "Missed and still repairing: the fresh question on the same idea, never the same question again. It is asked here only, not in the reply. Else null.",
      ),
    /** Missed: where the step leaked, in two or three sentences, for the note under the step; else null. */
    note: z.string().nullable(),
    /**
     * When the learner says, or their answer plainly shows, that they held this before the lesson
     * taught it ("I already know this"): what they held, in a sentence, with their words; else null.
     */
    alreadyHeld: z.string().nullable(),
    /** Term changes from how the learner used the terms, with their words as evidence. */
    actions: z.array(trackActionSchema),
  });
};

export const checkVerdictSchema = checkVerdictSchemaOf(CHECK_VERDICTS);
/** For an answer on a step the learner was already asked to show more on: it is decided. */
export const decidedCheckVerdictSchema = checkVerdictSchemaOf(["landed", "missed"]);

export type CheckVerdict = z.infer<typeof checkVerdictSchema>;

/** Ends with a question mark, with any closing emphasis, quote or bracket after it. */
const endsWithQuestion = (text: string) => /\?[*_"'”’)\]\s]*$/u.test(text);

/**
 * The rules of a verdict's shape that no validator of its text can see (design §7.3), fed back once,
 * like the rules of the text: a repair that still ends with a question while a fresh question is
 * given asks the learner twice in one message; an unproven answer is always followed by a fresh
 * question, and confirms no term, since it showed nothing.
 */
export function checkVerdictIssues(
  verdict: Pick<CheckVerdict, "verdict" | "reply" | "freshQuestion" | "actions">,
): Issue[] {
  const issues: Issue[] = [];
  if (verdict.freshQuestion && endsWithQuestion(verdict.reply))
    issues.push({
      code: "check/repair-asks",
      message:
        "The reply ends with a question while a freshQuestion is given too. The two are shown as one message, so the learner would be asked twice: end the reply without a question, and ask only in freshQuestion.",
    });
  if (verdict.verdict === "unproven") {
    if (!verdict.freshQuestion)
      issues.push({
        code: "check/unproven-asks-nothing",
        message:
          "The verdict is unproven but no freshQuestion is given. An answer that showed nothing yet is followed by a fresh question that makes the learner use the idea: give one in freshQuestion, or decide the answer, landed or missed.",
      });
    if (verdict.actions.some((a) => a.type === "set-term-status" && a.status === "confirmed"))
      issues.push({
        code: "check/unproven-confirms",
        message:
          "The verdict is unproven, yet a term is set confirmed from this answer. An answer that showed nothing confirms nothing: drop that edit, or decide the answer landed.",
      });
  }
  return issues;
}
