import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import type { SystemPrompt } from "@grounded/core";
import type { ProviderId } from "@grounded/providers";
import type { SystemModelMessage } from "ai";

/**
 * Anthropic's mark for a cache breakpoint: the prompt up to here is cached for an hour (design
 * §4.4). A learner reads, answers and asks at their own pace, often more than the default five
 * minutes apart; a write then costs 2x base input instead of 1.25x. Every mark, the top-level one
 * included, has the same lifetime: Anthropic requires longer-lived breakpoints before shorter ones.
 * The 1-hour lifetime needs no beta header.
 */
const CACHE_BREAKPOINT = { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } };

/**
 * The most cache breakpoints Anthropic accepts in one request; more is an error. The top-level
 * `cacheControl` (shapeCall) takes one of them. @ai-sdk/anthropic counts only the marks on blocks
 * (and drops those past 4), not the top-level one, so keeping within the limit is ours to do: the
 * system prompt marks at most 3 parts, and shapeCall leaves out the top-level mark when a prompt
 * already carries 4.
 */
export const MAX_CACHE_BREAKPOINTS = 4;

/**
 * A system prompt as the calls send it: one message per part, with the stable parts (the method's
 * shared sections, the phase's own, the track's state) marked as cache breakpoints, so a call of
 * another phase still reuses the shared sections, and a call whose own part differs still reuses
 * the method and the track, from the cache. An empty part is left out, with its mark. Only
 * Anthropic reads the marks; for the others the model middleware joins the parts back into the one
 * text assemblePrompt gives (see shapeCall).
 */
export function systemMessages(prompt: SystemPrompt): SystemModelMessage[] {
  const parts = [
    { content: prompt.sharedMethod, stable: true },
    { content: prompt.phaseMethod, stable: true },
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

/**
 * How hard the model thinks, per purpose (ModelRequest.purpose), where it differs from the
 * provider's default. Set through the AI SDK's provider-neutral `reasoning` option, which each
 * provider maps to its own: OpenAI's reasoning effort, Anthropic's thinking effort (or a thinking
 * budget on older models), Gemini's thinking level or budget.
 * - probe-decision, term-sweep, aside-record: small structured records of what the conversation
 *   already showed. The thinking happened in the conversation; a long think here only delays the
 *   learner's next message (the probe's decision spent up to 2,400 tokens reasoning; #13).
 * - left-off, conversation-summary, track-brief: summaries of what is already written ("where you
 *   left off", a long session's older turns, the files the learner attached).
 * Everything else keeps the default, above all plans, lessons and check grading, where a weak plan
 * or a wrong verdict costs more than the wait.
 */
export const REASONING: Readonly<
  Record<string, Exclude<LanguageModelV4CallOptions["reasoning"], undefined>>
> = {
  "probe-decision": "low",
  "term-sweep": "low",
  "aside-record": "low",
  "left-off": "low",
  "conversation-summary": "low",
  "track-brief": "low",
  "wording-review": "low",
};

/** What a call is for and about, as the middleware sees it (ModelRequest). */
export interface CallFacts {
  provider: ProviderId;
  purpose: string;
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
 *   the whole prompt, so the next call of the conversation reuses it; it is left out when the
 *   prompt's own marks already fill MAX_CACHE_BREAKPOINTS. Google caches implicitly.
 * - Reasoning effort: the purpose's, from REASONING.
 */
export function shapeCall(
  facts: CallFacts,
  params: LanguageModelV4CallOptions,
): LanguageModelV4CallOptions {
  const hints: SharedV4ProviderOptions = {};
  if (facts.provider === "anthropic" && breakpointsIn(params.prompt) < MAX_CACHE_BREAKPOINTS)
    hints.anthropic = CACHE_BREAKPOINT.anthropic;
  if (facts.provider === "openai" && facts.trackId)
    hints.openai = { promptCacheKey: facts.trackId };
  const reasoning = params.reasoning ?? REASONING[facts.purpose];
  return {
    ...params,
    prompt: separateSystemParts(params.prompt, facts.provider === "anthropic"),
    providerOptions: mergeProviderOptions(hints, params.providerOptions),
    ...(reasoning ? { reasoning } : {}),
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

/**
 * The Anthropic cache marks a prompt carries, on its messages and their parts. A message's mark
 * and its last part's may count as one there; counting both only errs on the safe side.
 */
function breakpointsIn(prompt: LanguageModelV4Prompt): number {
  const marked = (options: SharedV4ProviderOptions | undefined) =>
    options?.anthropic?.cacheControl || options?.anthropic?.cache_control ? 1 : 0;
  let count = 0;
  for (const message of prompt) {
    count += marked(message.providerOptions);
    if (typeof message.content !== "string")
      for (const part of message.content) count += marked(part.providerOptions);
  }
  return count;
}

function mergeProviderOptions(
  base: SharedV4ProviderOptions,
  over: SharedV4ProviderOptions | undefined,
): SharedV4ProviderOptions {
  const merged = { ...base };
  for (const [provider, options] of Object.entries(over ?? {}))
    merged[provider] = { ...base[provider], ...options };
  return merged;
}
