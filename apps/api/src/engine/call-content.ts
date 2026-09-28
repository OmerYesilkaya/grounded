import type {
  LanguageModelV4Content,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";

/*
 * What a model call was asked and what it answered, for its log line when LOG_CONTENT is on
 * (log.ts). The prompt's last turn is what a call asks (its instruction, the learner's answer, a
 * retry's feedback); the system prompt and the turns before it are the same across a session's calls
 * and are left out. Files and tool results are named, not copied.
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

/** A generated call's reply. */
export function describeReply(content: readonly LanguageModelV4Content[]): ReplyContent {
  const reply = new ReplyCollector();
  for (const part of content) {
    if (part.type === "text") reply.text += part.text;
    if (part.type === "reasoning") reply.reasoning += part.text;
    if (part.type === "tool-call") reply.toolCalls.push({ tool: part.toolName, input: part.input });
  }
  return reply.content();
}

/** A streamed call's reply, gathered part by part as it streams. */
export class ReplyCollector {
  text = "";
  reasoning = "";
  toolCalls: { tool: string; input: string }[] = [];

  add(part: LanguageModelV4StreamPart): void {
    if (part.type === "text-delta") this.text += part.delta;
    if (part.type === "reasoning-delta") this.reasoning += part.delta;
    if (part.type === "tool-call") this.toolCalls.push({ tool: part.toolName, input: part.input });
  }

  content(): ReplyContent {
    return {
      text: this.text,
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
      ...(this.toolCalls.length ? { toolCalls: this.toolCalls } : {}),
    };
  }
}
