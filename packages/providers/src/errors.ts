export type ProviderId = "anthropic" | "openai" | "google" | "deepseek";

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  deepseek: "DeepSeek",
};

/** The failures a learner can act on (design §4.4); everything else is "unknown". */
export type ProviderErrorKind =
  "invalid-key" | "no-credit" | "rate-limited" | "unreachable" | "timeout" | "refused" | "unknown";

/**
 * A failed call, for the learner: what kind of failure, and the provider by the name they know it.
 * The web words it in the app's language (design §9.3).
 */
export interface ProviderError {
  kind: ProviderErrorKind;
  provider: string;
}

/**
 * What we know about a failed call: an HTTP status and body, a thrown cause (network), or that it
 * ran out of time.
 */
export interface ProviderFailure {
  status?: number;
  body?: string;
  cause?: unknown;
  timedOut?: boolean;
}

/**
 * Maps a failed provider call onto the kind of failure it is. Accepts our own failure shape, the AI
 * SDK's APICallError (statusCode, responseBody), or a "TimeoutError" (what an abort signal's
 * timeout and the SDK's own timeouts throw). Based on each provider's documented error format.
 */
export function classifyProviderError(provider: ProviderId, error: unknown): ProviderError {
  const kind = classify(toFailure(error));
  return { kind, provider: PROVIDER_NAMES[provider] };
}

function toFailure(error: unknown): ProviderFailure {
  if (typeof error !== "object" || error === null) return { cause: error };
  const e = error as Record<string, unknown>;
  if (e.timedOut === true || e.name === "TimeoutError") return { timedOut: true };
  const status =
    typeof e.status === "number"
      ? e.status
      : typeof e.statusCode === "number"
        ? e.statusCode
        : undefined;
  const body =
    typeof e.body === "string"
      ? e.body
      : typeof e.responseBody === "string"
        ? e.responseBody
        : undefined;
  if (status === undefined) return { cause: "cause" in e ? e.cause : error };
  return { status, ...(body === undefined ? {} : { body }) };
}

function classify({ status, body = "", timedOut }: ProviderFailure): ProviderErrorKind {
  if (timedOut) return "timeout";
  if (status === undefined) return "unreachable";
  const text = body.toLowerCase();
  // DeepSeek answers 402 "Insufficient Balance"; the others say so in the body.
  if (
    status === 402 ||
    text.includes("insufficient_quota") ||
    text.includes("insufficient balance") ||
    text.includes("credit balance")
  )
    return "no-credit";
  if (
    status === 401 ||
    status === 403 ||
    text.includes("api_key_invalid") ||
    text.includes("api key not valid")
  ) {
    return "invalid-key";
  }
  if (status === 429) return "rate-limited";
  if (status >= 500) return "unreachable";
  if (text.includes("content_policy") || text.includes("safety")) return "refused";
  return "unknown";
}
