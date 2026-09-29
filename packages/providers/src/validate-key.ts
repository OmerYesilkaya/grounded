import { classifyProviderError, type ProviderError, type ProviderId } from "./errors.js";

export type KeyCheck = { ok: true } | ({ ok: false } & ProviderError);

/** Free endpoints that prove a key works. The key always travels in a header, never in the URL. */
const LIST_MODELS: Record<
  ProviderId,
  (key: string) => { url: string; headers: Record<string, string> }
> = {
  openai: (key) => ({
    url: "https://api.openai.com/v1/models",
    headers: { authorization: `Bearer ${key}` },
  }),
  anthropic: (key) => ({
    url: "https://api.anthropic.com/v1/models",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  }),
  google: (key) => ({
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    headers: { "x-goog-api-key": key },
  }),
  deepseek: (key) => ({
    url: "https://api.deepseek.com/models",
    headers: { authorization: `Bearer ${key}` },
  }),
};

/**
 * Checks a key by listing the provider's models, which costs nothing. It cannot tell whether the
 * account has credit; that surfaces on the first real call, through the same classifier.
 */
export async function validateKey(
  provider: ProviderId,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyCheck> {
  const { url, headers } = LIST_MODELS[provider](apiKey);
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (response.ok) return { ok: true };
    const body = await response.text();
    return { ok: false, ...classifyProviderError(provider, { status: response.status, body }) };
  } catch (cause) {
    return { ok: false, ...classifyProviderError(provider, { cause }) };
  }
}
