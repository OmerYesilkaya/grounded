import type {
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { jsonSchema, simulateReadableStream, type Tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { ModelAccess } from "../engine/model-call.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** One streamed reply. */
export interface StreamScript {
  /** Reasoning the model streams before anything else. */
  reasoning?: string;
  /** Web searches the provider runs (and answers) before the text. */
  searches?: string[];
  /** Text the model streams (or returns, for generate calls). */
  text?: string;
  /** Tools the model calls after its text. */
  calls?: { name: string; input: unknown }[];
}

export interface Scripted extends StreamScript {
  /** Later stream calls on the same model (a message asked for again…), in order. */
  thenStream?: StreamScript[];
  /** What follow-up generate calls on the same model return (a rewrite, a structured result…). */
  thenGenerate?: string[];
}

function streamed(script: StreamScript): LanguageModelV4StreamResult {
  const parts: LanguageModelV4StreamPart[] = [];
  if (script.reasoning) {
    parts.push({ type: "reasoning-start", id: "r" });
    parts.push({ type: "reasoning-delta", id: "r", delta: script.reasoning });
    parts.push({ type: "reasoning-end", id: "r" });
  }
  (script.searches ?? []).forEach((query, i) => {
    const toolCallId = `search-${String(i)}`;
    parts.push({
      type: "tool-call",
      toolCallId,
      toolName: "web_search",
      input: JSON.stringify({ query }),
      providerExecuted: true,
    });
    parts.push({
      type: "tool-result",
      toolCallId,
      toolName: "web_search",
      result: { sources: [] },
    });
  });
  if (script.text) {
    parts.push({ type: "text-start", id: "t" });
    for (let i = 0; i < script.text.length; i += 23)
      parts.push({ type: "text-delta", id: "t", delta: script.text.slice(i, i + 23) });
    parts.push({ type: "text-end", id: "t" });
  }
  (script.calls ?? []).forEach((call, i) =>
    parts.push({
      type: "tool-call",
      toolCallId: `call-${String(i)}`,
      toolName: call.name,
      input: JSON.stringify(call.input),
    }),
  );
  parts.push({
    type: "finish",
    finishReason: { unified: script.calls?.length ? "tool-calls" : "stop", raw: "stop" },
    usage,
  });
  return { stream: simulateReadableStream({ chunks: parts }) };
}

export function scriptedModel(script: Scripted): MockLanguageModelV4 {
  const generated = (text: string): LanguageModelV4GenerateResult => ({
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage,
    warnings: [],
  });
  return new MockLanguageModelV4({
    doStream: [script, ...(script.thenStream ?? [])].map(streamed),
    doGenerate: (script.thenGenerate ?? [script.text ?? ""]).map(generated),
  });
}

/** A stand-in for a provider's web search tool: the scripted model runs it and answers it. */
const searchTool: Tool = {
  type: "provider",
  id: "test.web_search",
  args: {},
  isProviderExecuted: true,
  inputSchema: jsonSchema({ type: "object", properties: { query: { type: "string" } } }),
};

/** Model access for tests: each purpose serves its scripted models in order. */
export function scriptedModels() {
  const queues = new Map<string, MockLanguageModelV4[]>();
  const used: { purpose: string; model: MockLanguageModelV4 }[] = [];
  let search = false;
  const access: ModelAccess = {
    model: ({ purpose }) => {
      const model = queues.get(purpose)?.shift();
      if (!model) return Promise.reject(new Error(`no scripted model for "${purpose}"`));
      used.push({ purpose, model });
      return Promise.resolve(model);
    },
    searchTool: () => Promise.resolve(search ? searchTool : undefined),
  };
  return {
    access,
    used,
    script(purpose: string, ...scripts: (Scripted | MockLanguageModelV4)[]) {
      const queue = queues.get(purpose) ?? [];
      queue.push(...scripts.map((s) => (s instanceof MockLanguageModelV4 ? s : scriptedModel(s))));
      queues.set(purpose, queue);
    },
    /** Gives the learner's provider a web search tool. */
    enableSearch() {
      search = true;
    },
    reset() {
      queues.clear();
      used.length = 0;
      search = false;
    },
  };
}
