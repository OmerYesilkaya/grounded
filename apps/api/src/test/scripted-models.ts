import type { LanguageModelV4GenerateResult, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { ModelAccess } from "../engine/model-call.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

export interface Scripted {
  /** Text the model streams (or returns, for generate calls). */
  text?: string;
  /** Tools the model calls after its text. */
  calls?: { name: string; input: unknown }[];
  /** What a follow-up generate call on the same model returns (a rewrite, a regeneration…). */
  thenGenerate?: string[];
}

export function scriptedModel(script: Scripted): MockLanguageModelV4 {
  const finishReason = {
    unified: script.calls?.length ? "tool-calls" : "stop",
    raw: "stop",
  } as const;
  const parts: LanguageModelV4StreamPart[] = [];
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
  parts.push({ type: "finish", finishReason, usage });
  const generated = (text: string): LanguageModelV4GenerateResult => ({
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage,
    warnings: [],
  });
  return new MockLanguageModelV4({
    doStream: { stream: simulateReadableStream({ chunks: parts }) },
    doGenerate: (script.thenGenerate ?? [script.text ?? ""]).map(generated),
  });
}

/** Model access for tests: each purpose serves its scripted models in order. */
export function scriptedModels() {
  const queues = new Map<string, MockLanguageModelV4[]>();
  const used: { purpose: string; model: MockLanguageModelV4 }[] = [];
  const access: ModelAccess = {
    model: ({ purpose }) => {
      const model = queues.get(purpose)?.shift();
      if (!model) return Promise.reject(new Error(`no scripted model for "${purpose}"`));
      used.push({ purpose, model });
      return Promise.resolve(model);
    },
    searchTool: () => Promise.resolve(undefined),
  };
  return {
    access,
    used,
    script(purpose: string, ...scripts: (Scripted | MockLanguageModelV4)[]) {
      const queue = queues.get(purpose) ?? [];
      queue.push(...scripts.map((s) => (s instanceof MockLanguageModelV4 ? s : scriptedModel(s))));
      queues.set(purpose, queue);
    },
    reset() {
      queues.clear();
      used.length = 0;
    },
  };
}
