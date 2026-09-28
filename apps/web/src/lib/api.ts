/** An API failure carrying the server's plain-language message. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  // A form sets its own content type, with the boundary.
  if (typeof init.body === "string") headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok)
    throw new ApiError(body?.error ?? "Something went wrong. Try again.", response.status);
  return body as T;
}

export type ProviderId = "anthropic" | "openai" | "google";

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
};
