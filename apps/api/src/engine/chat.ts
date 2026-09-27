import type { LanguageModelV4 } from "@ai-sdk/provider";
import {
  parseBlocks,
  validate,
  type Block,
  type Issue,
  type Surface,
  type TrackTerm,
} from "@grounded/content";
import { sessionMessages, type Db } from "@grounded/db";
import { generateText, streamText, type ModelMessage } from "ai";
import { v7 as uuidv7 } from "uuid";
import { publish } from "./events.js";
import { ProviderCallError } from "./model-call.js";

/** Attempts at getting a reply with any text in it (the message, or its rewrite). */
const TEXT_ATTEMPTS = 3;

export interface ChatMessageOptions {
  db: Db;
  sessionId: string;
  model: LanguageModelV4;
  system: string;
  messages: ModelMessage[];
  kind: "message" | "plan" | "homework" | "recap";
  terms: readonly TrackTerm[];
  surface?: Surface;
}

export interface ChatMessageResult {
  messageId: string;
  text: string;
  blocks: Block[];
}

/** Batches streamed text: one event per ~80 ms or 400 characters, not one per token. */
function batcher(flush: (text: string) => Promise<void>) {
  let pending = "";
  let last = Date.now();
  return {
    async add(delta: string) {
      pending += delta;
      if (pending.length >= 400 || Date.now() - last >= 80) {
        const text = pending;
        pending = "";
        last = Date.now();
        await flush(text);
      }
    },
    async end() {
      if (pending) await flush(pending);
      pending = "";
    },
  };
}

function chatIssues(
  text: string,
  surface: Surface,
  terms: readonly TrackTerm[],
): { blocks: Block[]; errors: Issue[] } {
  const parsed = parseBlocks(text);
  const errors = [...parsed.issues, ...validate(parsed.blocks, { surface, terms })].filter(
    (i) => i.severity !== "review",
  );
  return { blocks: parsed.blocks, errors };
}

const isBlank = (text: string) => text.trim() === "";

const emptyReplyNudge: ModelMessage = {
  role: "user",
  content: "(Your last reply had no text. Write the message itself now, in prose.)",
};

/**
 * Writes one tutor message into the session chat: streamed to the learner as it is written, then
 * validated against the surface's rules; if it breaks one, it is rewritten once with the issues.
 * A message that fails part-way is retracted, so no half-written message is left in the chat.
 *
 * The call offers no tools, so a model can't answer with a tool call in place of the message; actions
 * and phase decisions are a separate structured call made afterwards. A reply without text is never
 * stored: it is asked for again, and if every attempt is empty the message fails (and is retracted).
 */
export async function writeChatMessage(options: ChatMessageOptions): Promise<ChatMessageResult> {
  const { db, sessionId, kind } = options;
  const messageId = uuidv7();
  await publish(db, sessionId, "message-start", { id: messageId, role: "tutor", kind });
  let written: Omit<ChatMessageResult, "messageId">;
  try {
    written = await composeMessage(options, messageId);
    await db.insert(sessionMessages).values({
      id: messageId,
      sessionId,
      role: "tutor",
      text: written.text,
      blocks: written.blocks,
      kind,
    });
  } catch (error) {
    await publish(db, sessionId, "message-retracted", { id: messageId });
    throw error;
  }
  await publish(db, sessionId, "message-done", {
    id: messageId,
    role: "tutor",
    kind,
    blocks: written.blocks,
  });
  return { messageId, ...written };
}

async function composeMessage(
  options: ChatMessageOptions,
  messageId: string,
): Promise<Omit<ChatMessageResult, "messageId">> {
  const { db, sessionId } = options;
  const surface = options.surface ?? "chat";
  const deltas = batcher((text) =>
    publish(db, sessionId, "message-delta", { id: messageId, text }).then(() => undefined),
  );
  let text = "";
  for (let attempt = 0; attempt < TEXT_ATTEMPTS && isBlank(text); attempt++) {
    const stream = streamText({
      model: options.model,
      system: options.system,
      messages: attempt === 0 ? options.messages : [...options.messages, emptyReplyNudge],
    });
    for await (const delta of stream.textStream) await deltas.add(delta);
    await deltas.end();
    text = await stream.text;
  }
  if (isBlank(text))
    throw new ProviderCallError("unknown", "The tutor's reply came back empty. Try again.");

  const first = chatIssues(text, surface, options.terms);
  let { blocks } = first;
  if (first.errors.length > 0) {
    const rewrite = await rewritten(options, text, first.errors);
    // An empty rewrite is worse than the message the learner has already read.
    if (!isBlank(rewrite)) {
      text = rewrite;
      ({ blocks } = chatIssues(text, surface, options.terms));
    }
  }
  return { text, blocks };
}

async function rewritten(
  options: ChatMessageOptions,
  text: string,
  errors: readonly Issue[],
): Promise<string> {
  let rewrite = "";
  for (let attempt = 0; attempt < TEXT_ATTEMPTS && isBlank(rewrite); attempt++) {
    const result = await generateText({
      model: options.model,
      system: options.system,
      messages: [
        ...options.messages,
        { role: "assistant", content: text },
        {
          role: "user",
          content: `Rewrite your last message; it broke these rules:\n${errors.map((e) => `- ${e.message}`).join("\n")}\nReply with the rewritten message only.`,
        },
      ],
    });
    rewrite = result.text;
  }
  return rewrite;
}
