import type { LanguageModelV4 } from "@ai-sdk/provider";
import {
  parseBlocks,
  validate,
  type Block,
  type Issue,
  type Surface,
  type TrackTerm,
} from "@grounded/content";
import {
  and,
  asc,
  eq,
  inArray,
  lte,
  sessionEvents,
  sessionMessages,
  sql,
  type Db,
} from "@grounded/db";
import { generateText, streamText, type Instructions, type ModelMessage } from "ai";
import { v7 as uuidv7 } from "uuid";
import { log } from "../log.js";
import { batcher, publish, startActivity, withActivity } from "./events.js";
import { ProviderCallError } from "./model-call.js";

/** Attempts at getting a reply with any text in it (the message, or its rewrite). */
const TEXT_ATTEMPTS = 3;

export interface ChatMessageOptions {
  db: Db;
  sessionId: string;
  model: LanguageModelV4;
  system: Instructions;
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
    log.info({ messageId, kind }, "message failed; retracting it");
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
    if (attempt > 0)
      log.info({ messageId, kind: options.kind, attempt }, "reply came back empty; asking again");
    // Thinking lasts until the text starts: from then on the learner watches it being written.
    const thinking = await startActivity(
      db,
      sessionId,
      attempt === 0 ? "Thinking…" : "Thinking again (the reply came back empty)",
    );
    try {
      const reply = streamText({
        model: options.model,
        system: options.system,
        messages: attempt === 0 ? options.messages : [...options.messages, emptyReplyNudge],
      });
      for await (const part of reply.stream) {
        if (part.type === "error") throw part.error;
        if (part.type === "reasoning-delta") await thinking.reasoning(part.text);
        if (part.type === "text-delta") {
          if (!isBlank(part.text)) await thinking.done();
          await deltas.add(part.text);
        }
      }
      await deltas.end();
      text = await reply.text;
    } finally {
      await thinking.done();
    }
  }
  if (isBlank(text))
    throw new ProviderCallError("unknown", "The tutor's reply came back empty. Try again.");

  const first = chatIssues(text, surface, options.terms);
  let { blocks } = first;
  if (first.errors.length > 0) {
    log.info(
      { messageId, kind: options.kind, surface, issues: first.errors.map((i) => i.code) },
      "message broke rules; rewriting it",
    );
    const rewrite = await withActivity(
      db,
      sessionId,
      "Rewriting the message (it broke a chat rule)",
      () => rewritten(options, text, first.errors),
    );
    // An empty rewrite is worse than the message the learner has already read.
    if (!isBlank(rewrite)) {
      text = rewrite;
      const second = chatIssues(text, surface, options.terms);
      ({ blocks } = second);
      if (second.errors.length > 0)
        log.warn(
          { messageId, kind: options.kind, issues: second.errors.map((i) => i.code) },
          "rewritten message still breaks rules; keeping it",
        );
    } else
      log.warn({ messageId, kind: options.kind }, "rewrite came back empty; keeping the message");
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

interface MessageMark {
  id: string;
  role: "learner" | "tutor";
  kind: "message" | "plan" | "homework" | "recap";
}

/**
 * Tutor messages being written at the cursor: started, but neither stored nor retracted. The stream
 * resumes after the cursor, so their start and the text so far must come with the snapshot. A message
 * whose job died is one of these until recovery retracts it (recovery.ts).
 */
export async function messagesBeingWritten(
  db: Db,
  sessionId: string,
  cursor: number,
  stored: ReadonlySet<string>,
) {
  const upToCursor = and(eq(sessionEvents.sessionId, sessionId), lte(sessionEvents.id, cursor));
  const marks = await db
    .select({ type: sessionEvents.type, data: sessionEvents.data })
    .from(sessionEvents)
    .where(and(upToCursor, inArray(sessionEvents.type, ["message-start", "message-retracted"])))
    .orderBy(asc(sessionEvents.id));
  const open = new Map<string, MessageMark & { text: string }>();
  for (const { type, data } of marks) {
    const mark = data as MessageMark;
    if (type === "message-retracted") open.delete(mark.id);
    else if (!stored.has(mark.id))
      open.set(mark.id, { id: mark.id, role: mark.role, kind: mark.kind, text: "" });
  }
  if (open.size === 0) return [];

  const deltas = await db
    .select({ data: sessionEvents.data })
    .from(sessionEvents)
    .where(
      and(
        upToCursor,
        eq(sessionEvents.type, "message-delta"),
        inArray(sql<string>`${sessionEvents.data}->>'id'`, [...open.keys()]),
      ),
    )
    .orderBy(asc(sessionEvents.id));
  for (const { data } of deltas) {
    const delta = data as { id: string; text: string };
    const message = open.get(delta.id);
    if (message) message.text += delta.text;
  }
  return [...open.values()].map((m) => ({ ...m, blocks: null, streaming: true }));
}
