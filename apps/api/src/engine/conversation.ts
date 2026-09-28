import type { LanguageModelV4 } from "@ai-sdk/provider";
import { eq, learningSessions, type Db } from "@grounded/db";
import { generateText, type ModelMessage, type SystemModelMessage } from "ai";
import { withActivity } from "./events.js";

/*
 * A long session's conversation (design §4.4): past a generous length, the older turns are replaced
 * by a running summary and the last few stay in full. The summary changes only when it rolls
 * forward, so between rolls the conversation's start stays the same from call to call.
 */

/** The characters of messages after the summary a prompt carries before the older ones are summarized. */
export const CONVERSATION_LIMIT = 40_000;
/** The last messages that always stay in full. */
export const KEEP_RECENT = 10;

export interface StoredMessage {
  id: string;
  role: "learner" | "tutor";
  text: string | null;
}

export interface EarlierSummary {
  text: string;
  /** The last message the summary covers. */
  through: string;
}

/** The messages after the summary, or all of them without one (or if its last message is gone). */
function unsummarized(history: readonly StoredMessage[], summary: EarlierSummary | null) {
  const at = summary ? history.findIndex((m) => m.id === summary.through) : -1;
  return { covered: at >= 0, rest: history.slice(at + 1) };
}

/** The conversation as a prompt carries it: the summary of the older turns, then the rest in full. */
export function conversationFor(
  history: readonly StoredMessage[],
  summary: EarlierSummary | null,
): ModelMessage[] {
  const { covered, rest } = unsummarized(history, summary);
  const messages: ModelMessage[] = rest.map((m) =>
    m.role === "learner"
      ? { role: "user", content: m.text ?? "" }
      : { role: "assistant", content: m.text ?? "" },
  );
  if (covered && summary)
    messages.unshift({
      role: "user",
      content: `(The app: the start of this session, summarized. The conversation goes on from there.)\n\n${summary.text}`,
    });
  return messages;
}

/** The older messages to fold into the summary now, or none while the conversation is short enough. */
export function dueForSummary(
  history: readonly StoredMessage[],
  summary: EarlierSummary | null,
): StoredMessage[] {
  const { rest } = unsummarized(history, summary);
  const length = rest.reduce((sum, m) => sum + (m.text ?? "").length, 0);
  return length > CONVERSATION_LIMIT ? rest.slice(0, -KEEP_RECENT) : [];
}

const summaryRequest = (earlier: string | null, turns: readonly StoredMessage[]) =>
  [
    "(For the app; the learner doesn't see this.) This session's conversation has grown long, so its older turns are replaced by your summary of them; the latest stay in full. Summarize the turns below" +
      (earlier ? ", and the summary of the turns before them," : "") +
      " for your own later calls in this session: what was asked and answered, what the learner's answers showed (quote their own words wherever they are evidence for a term or a misconception), what was decided, and what is still open. Plain lines, as short as keeps all that. Reply with the summary only.",
    ...(earlier ? ["", "The summary so far:", "", earlier] : []),
    "",
    "The turns:",
    "",
    turns.map((m) => `${m.role === "learner" ? "Learner" : "Tutor"}: ${m.text ?? ""}`).join("\n\n"),
  ].join("\n");

/**
 * Rolls the session's summary forward over `turns` and stores it. Returns the new summary, or the
 * old one if the call fails (the prompt then carries more of the conversation in full).
 */
export async function summarizeEarlier(options: {
  db: Db;
  sessionId: string;
  model: () => Promise<LanguageModelV4>;
  system: SystemModelMessage[];
  summary: EarlierSummary | null;
  turns: readonly StoredMessage[];
}): Promise<EarlierSummary | null> {
  const { db, sessionId, summary, turns } = options;
  const last = turns.at(-1);
  if (!last) return summary;
  try {
    const model = await options.model();
    const { text } = await withActivity(db, sessionId, "Condensing our conversation so far", () =>
      generateText({
        model,
        system: options.system,
        prompt: summaryRequest(summary?.text ?? null, turns),
      }),
    );
    if (!text.trim()) return summary;
    const next = { text: text.trim(), through: last.id };
    await db
      .update(learningSessions)
      .set({ earlierSummary: next.text, summarizedThrough: next.through })
      .where(eq(learningSessions.id, sessionId));
    return next;
  } catch {
    return summary;
  }
}
