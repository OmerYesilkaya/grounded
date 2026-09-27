export type ProviderId = "anthropic" | "openai" | "google";

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
};

/** The failures a learner can act on (design §4.4); everything else is "unknown". */
export type ProviderErrorKind =
  "invalid-key" | "no-credit" | "rate-limited" | "unreachable" | "refused" | "unknown";

export interface ProviderError {
  kind: ProviderErrorKind;
  message: string;
}

/** What we know about a failed call: an HTTP status and body, or a thrown cause (network). */
export interface ProviderFailure {
  status?: number;
  body?: string;
  cause?: unknown;
}

const messages: Record<ProviderErrorKind, (name: string) => string> = {
  "invalid-key": (n) =>
    `Your ${n} key was rejected. Check it in Settings, or create a new one on ${n}'s site.`,
  "no-credit": (n) =>
    `Your ${n} account is out of credit. Add credit or raise your spending limit on ${n}'s site.`,
  "rate-limited": (n) => `${n} is limiting requests right now. Wait a minute, then try again.`,
  unreachable: (n) => `${n} couldn't be reached. Try again in a moment.`,
  refused: (n) => `${n} declined to answer this request.`,
  unknown: (n) => `Something went wrong talking to ${n}. Try again in a moment.`,
};

/**
 * Maps a failed provider call onto a plain message. Accepts our own failure shape or the AI SDK's
 * APICallError (statusCode, responseBody). Based on each provider's documented error format.
 */
export function classifyProviderError(provider: ProviderId, error: unknown): ProviderError {
  const kind = classify(toFailure(error));
  return { kind, message: messages[kind](PROVIDER_NAMES[provider]) };
}

function toFailure(error: unknown): ProviderFailure {
  if (typeof error !== "object" || error === null) return { cause: error };
  const e = error as Record<string, unknown>;
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

function classify({ status, body = "" }: ProviderFailure): ProviderErrorKind {
  if (status === undefined) return "unreachable";
  const text = body.toLowerCase();
  if (text.includes("insufficient_quota") || text.includes("credit balance")) return "no-credit";
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
