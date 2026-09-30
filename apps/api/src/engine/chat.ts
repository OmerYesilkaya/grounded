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
import type { Reviewer } from "@grounded/core";
import { generateText, streamText, type Instructions, type ModelMessage } from "ai";
import { v7 as uuidv7 } from "uuid";
import { content, log } from "../log.js";
import { withVerifiedLinks, type VerifierOptions } from "../media/verify.js";
import { traced, verdictIssues } from "./call-trace.js";
import { batcher, publish, startActivity, withActivity, type Activity } from "./events.js";
import { ProviderCallError } from "./model-call.js";

/** What a chat message is: the review's, the probe's, the plan, the homework, the final's parts… */
export type MessageKind = (typeof sessionMessages.$inferSelect)["kind"];

/** Attempts at getting a reply with any text in it (the message, or its rewrite). */
const TEXT_ATTEMPTS = 3;

export interface ChatMessageOptions {
  db: Db;
  sessionId: string;
  model: LanguageModelV4;
  system: Instructions;
  messages: ModelMessage[];
  kind: MessageKind;
  terms: readonly TrackTerm[];
  surface?: Surface;
  /** Where the message's links are verified before it is stored (design §6.4). */
  media: VerifierOptions;
  /** Judges what the validators can't decide by matching (design §3.3). */
  review: Reviewer;
}

export interface ChatMessageResult {
  messageId: string;
  text: string;
  blocks: Block[];
}

/** A tutor reply streamed to the learner and then validated: a chat message, or an aside's answer. */
export interface ReplyOptions {
  db: Db;
  sessionId: string;
  model: LanguageModelV4;
  system: Instructions;
  messages: ModelMessage[];
  terms: readonly TrackTerm[];
  surface: Surface;
  /** Terms the surroundings teach (a lesson's steps so far), usable here. */
  introduced?: readonly string[];
  /** Receives the text as it streams, in batches. */
  onText: (text: string) => Promise<void>;
  /**
   * Show "Thinking…" and a rewrite in the session's activity line (default true). An aside's card
   * shows its own state instead.
   */
  activities?: boolean;
  /** Ids for its log lines: the message, the aside. */
  logFields: Record<string, unknown>;
  /** Where the reply's links are verified before it is stored (design §6.4). */
  media: VerifierOptions;
  /** Judges what the validators can't decide by matching (design §3.3). */
  review: Reviewer;
}

/** A text's blocks, the rules it breaks, and the words flagged for the review (design §3.3). */
export function chatIssues(
  text: string,
  surface: Surface,
  terms: readonly TrackTerm[],
  introduced: readonly string[] = [],
): { blocks: Block[]; errors: Issue[]; flagged: Issue[] } {
  const parsed = parseBlocks(text);
  const issues = [...parsed.issues, ...validate(parsed.blocks, { surface, terms, introduced })];
  return {
    blocks: parsed.blocks,
    errors: issues.filter((i) => i.severity !== "review"),
    flagged: issues.filter((i) => i.severity === "review"),
  };
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
    written = await composeReply({
      ...options,
      surface: options.surface ?? "chat",
      onText: (text) =>
        publish(db, sessionId, "message-delta", { id: messageId, text }).then(() => undefined),
      logFields: { messageId, kind },
    });
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

/** Stands in for an activity that isn't shown. */
const unseen: Activity = {
  update: () => Promise.resolve(),
  reasoning: () => Promise.resolve(),
  done: () => Promise.resolve(),
};

/**
 * Streams a tutor reply through `onText`, then validates it against the surface's rules; if it
 * breaks one, it is rewritten once with the issues (the rewrite replaces what was streamed). A reply
 * without text is asked for again; if every attempt is empty, it fails. The draft's verdict and the
 * rewrite's are stored on their calls (call-trace.ts).
 */
export async function composeReply(
  options: ReplyOptions,
): Promise<Omit<ChatMessageResult, "messageId">> {
  const { db, sessionId, surface, logFields } = options;
  const shown = options.activities ?? true;
  const deltas = batcher(options.onText);
  let text = "";
  const draft = await traced(async () => {
    for (let attempt = 0; attempt < TEXT_ATTEMPTS && isBlank(text); attempt++) {
      if (attempt > 0) log.info({ ...logFields, attempt }, "reply came back empty; asking again");
      // Thinking lasts until the text starts: from then on the learner watches it being written.
      const thinking = shown
        ? await startActivity(db, sessionId, { code: "thinking", again: attempt > 0 })
        : unseen;
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
  });
  if (isBlank(text)) throw new ProviderCallError("unknown", { code: "empty-reply" });

  const first = chatIssues(text, surface, options.terms, options.introduced);
  let { blocks } = first;
  // What matching can't decide, judged by the cheap model; one rewrite fixes both kinds.
  first.errors.push(
    ...(await options.review({
      markdown: text,
      flagged: first.flagged,
      terms: options.terms,
      introduced: options.introduced ?? [],
    })),
  );
  await draft.judge({ rewrite: 0, issues: verdictIssues(first.errors) });
  if (first.errors.length > 0) {
    log.info(
      {
        ...logFields,
        surface,
        issues: first.errors.map((i) => i.code),
        ...content({ issues: first.errors.map((i) => i.message) }),
      },
      "message broke rules; rewriting it",
    );
    const rewrite = shown
      ? await withActivity(db, sessionId, { code: "rewriting-message" }, () =>
          rewritten(options, text, first.errors),
        )
      : await rewritten(options, text, first.errors);
    // An empty rewrite is worse than the message the learner has already read.
    if (!isBlank(rewrite.value)) {
      text = rewrite.value;
      const second = chatIssues(text, surface, options.terms, options.introduced);
      ({ blocks } = second);
      await rewrite.judge({ rewrite: 1, issues: verdictIssues(second.errors) });
      if (second.errors.length > 0)
        log.warn(
          { ...logFields, issues: second.errors.map((i) => i.code) },
          "rewritten message still breaks rules; keeping it",
        );
    } else log.warn(logFields, "rewrite came back empty; keeping the message");
  }
  return { text, blocks: await withVerifiedLinks(blocks, options.media) };
}

/**
 * The rewrite of a message that broke rules ("" if every attempt came back empty), traced for its
 * verdict.
 */
function rewritten(options: ReplyOptions, text: string, errors: readonly Issue[]) {
  return traced(async () => {
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
  });
}

interface MessageMark {
  id: string;
  role: "learner" | "tutor";
  kind: MessageKind;
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
