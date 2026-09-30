import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import type { StoredJson, StoredReply } from "@grounded/db";
import { APICallError, RetryError } from "ai";

/*
 * What a model call was asked and what it answered: in full for its `model_calls` row (design
 * §4.4), and in brief for its log line when LOG_CONTENT is on (log.ts, §4.2).
 *
 * The log line's prompt is its last turn, what a call asks (its instruction, the learner's answer, a
 * retry's feedback); the system prompt and the turns before it are the same across a session's calls
 * and are left out. The row holds every message as sent. Both name files rather than copy them.
 */

export interface CallContent {
  /** How many messages the prompt had, the system prompt included. */
  messages: number;
  /** The prompt's last message: its role and its text. */
  lastTurn: { role: string; text: string } | null;
  /** Whether the call asked for JSON (a structured record). */
  json: boolean;
}

export interface ReplyContent {
  text: string;
  reasoning?: string;
  toolCalls?: { tool: string; input: string }[];
}

/** A reply as the middleware gathers it: its parts, and how it ended. */
export interface Reply {
  content: LanguageModelV4Content[];
  finishReason?: LanguageModelV4FinishReason;
  providerMetadata?: SharedV4ProviderMetadata;
}

type Part = Exclude<LanguageModelV4Message["content"], string>[number];

const partText = (part: Part): string => {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text;
    case "file":
      return `[file ${part.mediaType}]`;
    case "tool-call":
      return `[tool call ${part.toolName}: ${JSON.stringify(part.input)}]`;
    case "tool-result":
      return `[tool result ${part.toolName}]`;
    default:
      return `[${part.type}]`;
  }
};

export function describePrompt(
  prompt: LanguageModelV4Prompt,
  responseFormat?: { type: string },
): CallContent {
  const last = prompt.at(-1);
  return {
    messages: prompt.length,
    lastTurn: last
      ? {
          role: last.role,
          text:
            typeof last.content === "string" ? last.content : last.content.map(partText).join("\n"),
        }
      : null,
    json: responseFormat?.type === "json",
  };
}

/** A reply in brief, for the log. */
export function describeReply(content: readonly LanguageModelV4Content[]): ReplyContent {
  let text = "";
  let reasoning = "";
  const toolCalls: { tool: string; input: string }[] = [];
  for (const part of content) {
    if (part.type === "text") text += part.text;
    if (part.type === "reasoning") reasoning += part.text;
    if (part.type === "tool-call") toolCalls.push({ tool: part.toolName, input: part.input });
  }
  return {
    text,
    ...(reasoning ? { reasoning } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
  };
}

/**
 * A streamed call's reply, gathered part by part as it streams into the parts a generated call
 * returns: each text and reasoning run joined into one part, the rest (tool calls and results,
 * sources, files) as they came.
 */
export class ReplyCollector {
  private readonly parts: LanguageModelV4Content[] = [];
  /** The text and reasoning parts still streaming, by their stream id. */
  private readonly open = new Map<string, { text: string }>();
  private finishReason: LanguageModelV4FinishReason | undefined;
  private providerMetadata: SharedV4ProviderMetadata | undefined;

  add(part: LanguageModelV4StreamPart): void {
    switch (part.type) {
      case "text-start":
      case "reasoning-start":
        this.start(part.type === "text-start" ? "text" : "reasoning", part.id);
        return;
      case "text-delta":
      case "reasoning-delta":
        (
          this.open.get(part.id) ??
          this.start(part.type === "text-delta" ? "text" : "reasoning", part.id)
        ).text += part.delta;
        return;
      case "text-end":
      case "reasoning-end":
        this.open.delete(part.id);
        return;
      case "tool-call":
      case "tool-result":
      case "tool-approval-request":
      case "file":
      case "reasoning-file":
      case "source":
      case "custom":
        this.parts.push(part);
        return;
      case "finish":
        this.finishReason = part.finishReason;
        this.providerMetadata = part.providerMetadata;
        return;
      default:
        // A tool's input as it streams (the call has it whole), metadata, raw chunks, errors.
        return;
    }
  }

  private start(type: "text" | "reasoning", id: string): { text: string } {
    const part = { type, text: "" };
    this.parts.push(part);
    this.open.set(id, part);
    return part;
  }

  reply(): Reply {
    return {
      content: this.parts,
      ...(this.finishReason ? { finishReason: this.finishReason } : {}),
      ...(this.providerMetadata ? { providerMetadata: this.providerMetadata } : {}),
    };
  }
}

/** A reply for its `model_calls` row. */
export function storedReply(reply: Reply): StoredReply {
  return {
    content: reply.content.map((part) => storable(part)),
    ...(reply.finishReason ? { finishReason: storable(reply.finishReason) } : {}),
    ...(reply.providerMetadata ? { providerMetadata: storable(reply.providerMetadata) } : {}),
  };
}

/** What a call was sent, for its `model_calls` row: the options but the abort signal and headers. */
export function storedRequest(params: LanguageModelV4CallOptions) {
  const { prompt, responseFormat, tools, ...rest } = params;
  const settings = Object.fromEntries(
    Object.entries(rest).filter(([key]) => key !== "abortSignal" && key !== "headers"),
  );
  return {
    prompt: prompt.map((message) => storable(message)),
    responseFormat: responseFormat?.type === "json" ? storable(responseFormat) : null,
    tools: tools?.length ? tools.map((tool) => storable(tool)) : null,
    settings: storable(settings) as Record<string, StoredJson>,
  };
}

/**
 * A failed call's error for its `model_calls` row: its type and message, a provider's status and
 * response body, and its cause chain. Unlike the log's (log.ts), nothing is withheld.
 */
export function storedError(error: unknown, depth = 0): StoredJson {
  if (!(error instanceof Error)) return { type: typeof error, message: storable(String(error)) };
  const cause = RetryError.isInstance(error) ? error.lastError : error.cause;
  return {
    type: error.name,
    message: storable(error.message),
    ...(APICallError.isInstance(error)
      ? {
          ...(error.statusCode !== undefined ? { status: error.statusCode } : {}),
          ...(error.responseBody ? { body: storable(error.responseBody) } : {}),
        }
      : {}),
    ...(cause !== undefined && depth < 5 ? { cause: storedError(cause, depth + 1) } : {}),
  };
}

/** Deeper than any prompt or reply goes: a cycle, which JSON can't hold. */
const MAX_DEPTH = 64;

/**
 * A value as JSON that Postgres can store: a file's bytes are named by their size rather than
 * copied (§4.5 keeps the files themselves), URLs and dates become strings, and NUL characters,
 * which Postgres text can't hold, become U+FFFD.
 */
export function storable(value: unknown, depth = 0): StoredJson {
  if (depth > MAX_DEPTH) return "[too deep]";
  switch (typeof value) {
    case "string":
      return value.replaceAll("\u0000", "�");
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "object":
      break;
    default:
      return null;
  }
  if (value === null) return null;
  if (value instanceof Uint8Array) return { bytes: value.byteLength };
  if (value instanceof URL) return value.href;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => storable(item, depth + 1));
  // A file part (in the prompt, a reply or a tool's result) has a media type beside its data.
  const isFile = "mediaType" in value && "data" in value;
  const stored: Record<string, StoredJson> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || typeof item === "function") continue;
    stored[key] = isFile && key === "data" ? namedData(item) : storable(item, depth + 1);
  }
  return stored;
}

/** A file's data, named: its size, its URL or reference, never its bytes or its text. */
function namedData(data: unknown): StoredJson {
  if (data instanceof Uint8Array || typeof data === "string") return sizeOf(data);
  if (data instanceof URL) return { url: data.href };
  if (typeof data !== "object" || data === null || !("type" in data)) return null;
  const file = data as { type: unknown; data?: unknown; text?: unknown };
  switch (file.type) {
    case "data":
      return {
        type: "data",
        ...(file.data instanceof Uint8Array || typeof file.data === "string"
          ? sizeOf(file.data)
          : {}),
      };
    case "text":
      return { type: "text", characters: typeof file.text === "string" ? file.text.length : 0 };
    default:
      // A URL or a provider's reference: a name already.
      return storable(data);
  }
}

/** Bytes by their count; base64 by its length, which is what the model was sent. */
const sizeOf = (data: Uint8Array | string) =>
  typeof data === "string" ? { base64Characters: data.length } : { bytes: data.byteLength };
