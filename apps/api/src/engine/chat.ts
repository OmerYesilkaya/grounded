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
import {
  generateText,
  stepCountIs,
  streamText,
  type ModelMessage,
  type ToolSet,
  type TypedToolCall,
} from "ai";
import { v7 as uuidv7 } from "uuid";
import { publish } from "./events.js";

export interface ChatMessageOptions {
  db: Db;
  sessionId: string;
  model: LanguageModelV4;
  system: string;
  messages: ModelMessage[];
  kind: "message" | "plan" | "homework" | "recap";
  terms: readonly TrackTerm[];
  surface?: Surface;
  tools?: ToolSet;
  /** Allow a few steps when tools run on the provider (web search). */
  maxSteps?: number;
}

export interface ChatMessageResult {
  messageId: string;
  text: string;
  blocks: Block[];
  toolCalls: TypedToolCall<ToolSet>[];
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

/**
 * Writes one tutor message into the session chat: streamed to the learner as it is written, then
 * validated against the surface's rules; if it breaks one, it is rewritten once with the issues.
 * A message that fails part-way is retracted, so no half-written message is left in the chat.
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
  const stream = streamText({
    model: options.model,
    system: options.system,
    messages: options.messages,
    ...(options.tools ? { tools: options.tools } : {}),
    stopWhen: stepCountIs(options.maxSteps ?? 1),
  });
  for await (const delta of stream.textStream) await deltas.add(delta);
  await deltas.end();

  let text = await stream.text;
  const toolCalls = await stream.toolCalls;
  const first = chatIssues(text, surface, options.terms);
  let { blocks } = first;
  const { errors } = first;
  if (errors.length > 0) {
    const retry = await generateText({
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
    text = retry.text;
    ({ blocks } = chatIssues(text, surface, options.terms));
  }

  return { text, blocks, toolCalls };
}
