import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import type { SystemPrompt } from "@grounded/core";
import type { ProviderId } from "@grounded/providers";
import type { SystemModelMessage } from "ai";

/** Anthropic's mark for a cache breakpoint: the prompt up to here is cached (5 minutes). */
const CACHE_BREAKPOINT = { anthropic: { cacheControl: { type: "ephemeral" } } };

/**
 * A system prompt as the calls send it: one message per part, with the stable parts (the method,
 * the track's state) marked as cache breakpoints, so a call whose own part differs still reuses the
 * method and the track from the cache. Only Anthropic reads the marks; for the others the model
 * middleware joins the parts back into the one text assemblePrompt gives (see shapeCall).
 */
export function systemMessages(prompt: SystemPrompt): SystemModelMessage[] {
  const parts = [
    { content: prompt.method, stable: true },
    { content: prompt.track, stable: true },
    { content: prompt.call, stable: false },
  ];
  return parts
    .filter((part) => part.content)
    .map(({ content, stable }) =>
      stable
        ? { role: "system", content, providerOptions: CACHE_BREAKPOINT }
        : { role: "system", content },
    );
}

/** What a call is for and about, as the middleware sees it (ModelRequest). */
export interface CallFacts {
  provider: ProviderId;
  /** The track the call is about, when there is one: its calls share one cache. */
  trackId?: string | undefined;
}

/**
 * Shapes a call for the learner's provider (design §4.4), applied to every call in the model
 * middleware; what the caller set itself wins.
 * - The system prompt's parts are separated as assemblePrompt joins them: Anthropic keeps them as
 *   separate blocks (its breakpoints sit between them), the others get one system message.
 * - Caching. OpenAI: `promptCacheKey` is the track, so a track's calls reach the same cache.
 *   Anthropic: besides the breakpoints in the system prompt, the top-level `cacheControl` caches
 *   the whole prompt, so the next call of the conversation reuses it. Google caches implicitly.
 */
export function shapeCall(
  facts: CallFacts,
  params: LanguageModelV4CallOptions,
): LanguageModelV4CallOptions {
  const hints: SharedV4ProviderOptions = {};
  if (facts.provider === "anthropic") hints.anthropic = CACHE_BREAKPOINT.anthropic;
  if (facts.provider === "openai" && facts.trackId)
    hints.openai = { promptCacheKey: facts.trackId };
  return {
    ...params,
    prompt: separateSystemParts(params.prompt, facts.provider === "anthropic"),
    providerOptions: mergeProviderOptions(hints, params.providerOptions),
  };
}

/** The leading system messages, as blocks ending in the parts' separator, or joined into one. */
function separateSystemParts(
  prompt: LanguageModelV4Prompt,
  asBlocks: boolean,
): LanguageModelV4Prompt {
  const system: SystemMessage[] = [];
  for (const message of prompt) {
    if (message.role !== "system") break;
    system.push(message);
  }
  if (system.length < 2) return prompt;
  const rest = prompt.slice(system.length);
  if (asBlocks) {
    const blocks = system.map((message, i) =>
      i < system.length - 1 ? { ...message, content: `${message.content}\n\n` } : message,
    );
    return [...blocks, ...rest];
  }
  return [{ role: "system", content: system.map((m) => m.content).join("\n\n") }, ...rest];
}

type SystemMessage = Extract<LanguageModelV4Prompt[number], { role: "system" }>;

function mergeProviderOptions(
  base: SharedV4ProviderOptions,
  over: SharedV4ProviderOptions | undefined,
): SharedV4ProviderOptions {
  const merged = { ...base };
  for (const [provider, options] of Object.entries(over ?? {}))
    merged[provider] = { ...base[provider], ...options };
  return merged;
}
