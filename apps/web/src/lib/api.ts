import { isNotice, type Notice } from "@grounded/core/notices";
import { currentMessages } from "@/i18n";
import { wordNotice } from "@/i18n/notice";
/**
 * An API failure: the server's notice saying why (design §9.3), its message worded in the app's
 * language as it was when the failure came, and the rest of what it answered.
 */
export class ApiError extends Error {
  constructor(
    readonly notice: Notice | null,
    readonly status: number,
    readonly body: Record<string, unknown> | null = null,
  ) {
    const t = currentMessages();
    super(notice ? wordNotice(notice, t) : t.common.failed);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  // A form sets its own content type, with the boundary.
  if (typeof init.body === "string") headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok)
    throw new ApiError(isNotice(body?.error) ? body.error : null, response.status, body);
  return body as T;
}

export type ProviderId = "anthropic" | "openai" | "google" | "deepseek";

export interface Credential {
  provider: ProviderId;
  model: string;
  keyHint: string;
  source: "own_key" | "sponsored";
}

export type ModelOptions = Record<ProviderId, { id: string; label: string }[]>;

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  deepseek: "DeepSeek",
};
