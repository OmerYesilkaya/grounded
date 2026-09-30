import type { Issue } from "@grounded/content";
import { z } from "zod";
import { trackActionSchema } from "./actions.js";

/**
 * What the model returns when it grades a check (method.md, "Checks inside the lesson"). Every key is
 * required (null when unused): strict structured outputs reject optional properties.
 */
export const checkVerdictSchema = z.object({
  verdict: z.enum(["landed", "missed"]),
  /**
   * Landed: a few words. Missed: the repair of that one piece. The app shows it and the fresh
   * question as one tutor message, or the repair alone when it withholds the question (design §7.3).
   */
  reply: z
    .string()
    .min(1)
    .describe(
      "Landed: a few words. Missed: the repair of the one piece that leaked, rebuilt from what it rests on. When you give a freshQuestion, the reply asks nothing: it ends without a question, and the app shows the freshQuestion right after it, in the same message.",
    ),
  /** Missed and still repairing: a fresh question on the same idea, never the same question; else null. */
  freshQuestion: z
    .string()
    .nullable()
    .describe(
      "Missed and still repairing: the fresh question on the same idea, never the same question again. It is asked here only, not in the reply. Else null.",
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

export type CheckVerdict = z.infer<typeof checkVerdictSchema>;

/** Ends with a question mark, with any closing emphasis, quote or bracket after it. */
const endsWithQuestion = (text: string) => /\?[*_"'”’)\]\s]*$/u.test(text);

/**
 * The rule of a verdict's shape that no validator of its text can see: a repair that still ends
 * with a question while a fresh question is given asks the learner twice in one message (design
 * §7.3). Fed back once, like the rules of the text.
 */
export function checkVerdictIssues(
  verdict: Pick<CheckVerdict, "reply" | "freshQuestion">,
): Issue[] {
  if (!verdict.freshQuestion || !endsWithQuestion(verdict.reply)) return [];
  return [
    {
      code: "check/repair-asks",
      message:
        "The reply ends with a question while a freshQuestion is given too. The two are shown as one message, so the learner would be asked twice: end the reply without a question, and ask only in freshQuestion.",
    },
  ];
}
