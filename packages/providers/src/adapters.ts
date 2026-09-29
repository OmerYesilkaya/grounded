import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ProviderId } from "./errors.js";

/** A language model for one call, built with the learner's key (decrypted by the caller). */
export function createLanguageModel(
  provider: ProviderId,
  modelId: string,
  apiKey: string,
): LanguageModelV4 {
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(modelId);
    case "openai":
      return createOpenAI({ apiKey })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(modelId);
    case "deepseek":
      return createDeepSeek({ apiKey })(modelId);
  }
}

/**
 * The provider's own web search, for research during planning and fact checks (design §4.4).
 * Undefined when a provider has none: DeepSeek's API has no search, so a learner on it gets no
 * research; the plan and each lesson are written from the model's own knowledge.
 */
export function createSearchTool(provider: ProviderId, apiKey: string) {
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey }).tools.webSearch_20260318({ maxUses: 5 });
    case "openai":
      return createOpenAI({ apiKey }).tools.webSearch({});
    case "google":
      return createGoogleGenerativeAI({ apiKey }).tools.googleSearch({});
    case "deepseek":
      return undefined;
  }
}
