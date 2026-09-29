import { describe, expect, it, vi } from "vitest";
import { validateKey } from "./index.js";

const reply = (status: number, body: unknown = {}) =>
  vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(body), { status })));

describe("validateKey", () => {
  it.each([
    ["openai", "https://api.openai.com/v1/models", { authorization: "Bearer sk-test" }],
    [
      "anthropic",
      "https://api.anthropic.com/v1/models",
      { "x-api-key": "sk-test", "anthropic-version": "2023-06-01" },
    ],
    [
      "google",
      "https://generativelanguage.googleapis.com/v1beta/models",
      { "x-goog-api-key": "sk-test" },
    ],
    ["deepseek", "https://api.deepseek.com/models", { authorization: "Bearer sk-test" }],
  ] as const)(
    "asks %s to list models with the key in a header, never the URL",
    async (provider, url, headers) => {
      const fetch = reply(200, { data: [] });
      expect(await validateKey(provider, "sk-test", fetch)).toEqual({ ok: true });

      const [calledUrl, init] = fetch.mock.calls[0] ?? [];
      expect(calledUrl).toBe(url);
      expect(typeof calledUrl === "string" && !calledUrl.includes("sk-test")).toBe(true);
      expect(Object.fromEntries(new Headers(init?.headers).entries())).toMatchObject(headers);
    },
  );

  it("reports a rejected key with the plain message", async () => {
    const result = await validateKey(
      "openai",
      "sk-bad",
      reply(401, { error: { code: "invalid_api_key" } }),
    );
    expect(result).toEqual({
      ok: false,
      kind: "invalid-key",
      message:
        "Your OpenAI key was rejected. Check it in Settings, or create a new one on OpenAI's site.",
    });
  });

  it("reports an unreachable provider", async () => {
    const offline = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("fetch failed")));
    expect(await validateKey("anthropic", "sk-test", offline)).toMatchObject({
      ok: false,
      kind: "unreachable",
    });
  });
});
