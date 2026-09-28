import type { LanguageModelV4 } from "@ai-sdk/provider";
import { generateText } from "ai";
import type { Persona } from "./persona.js";

/** The scripted learner's side of a session: it is shown what the learner has seen, and replies. */
export interface Learner {
  reply(seen: string, task: string): Promise<string>;
}

/** A fixed strong model playing the persona. */
export function modelLearner(model: LanguageModelV4, persona: Persona): Learner {
  const system = `You are playing a learner, to test a tutoring app. You are this person:

${persona.sheet}

Stay in character throughout:
- Know exactly what the sheet says you know, and nothing more. Never use knowledge the sheet doesn't give you, even when you could guess the tutor's answer; what the tutor has taught you in this session you now know.
- Write as this person types in a chat box: in their language (${persona.language}), in their voice, briefly.
- Never mention that you are playing a role, a sheet or a test.
- Reply with only what you would type, nothing else.`;
  return {
    async reply(seen, task) {
      const { text } = await generateText({
        model,
        system,
        prompt: `What you have seen so far in the app:\n\n${seen}\n\n---\n\n${task}`,
      });
      return text.trim();
    },
  };
}

export const TASKS = {
  chat: "The tutor's last message is above. Type your reply.",
  plan: "The tutor has proposed the plan above. If it works for you, reply with exactly APPROVE. If not, type what you would say to the tutor to change it.",
  check:
    "You have read the lesson up to here. Answer the tutor's latest question, at the end of the step you just read or in its check thread below it.",
} as const;
