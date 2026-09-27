import { describe, expect, it } from "vitest";
import { classifyProviderError } from "./index.js";

const http = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });

describe("classifyProviderError", () => {
  it.each([
    [
      "openai",
      http(401, { error: { code: "invalid_api_key", message: "Incorrect API key provided" } }),
      "invalid-key",
    ],
    [
      "openai",
      http(429, {
        error: { code: "insufficient_quota", message: "You exceeded your current quota" },
      }),
      "no-credit",
    ],
    [
      "openai",
      http(429, { error: { code: "rate_limit_exceeded", message: "Rate limit reached" } }),
      "rate-limited",
    ],
    [
      "openai",
      http(400, { error: { code: "content_policy_violation", message: "rejected" } }),
      "refused",
    ],
    [
      "anthropic",
      http(401, {
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
      }),
      "invalid-key",
    ],
    [
      "anthropic",
      http(403, { type: "error", error: { type: "permission_error", message: "not allowed" } }),
      "invalid-key",
    ],
    [
      "anthropic",
      http(400, {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Your credit balance is too low to access the Anthropic API.",
        },
      }),
      "no-credit",
    ],
    [
      "anthropic",
      http(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }),
      "rate-limited",
    ],
    [
      "anthropic",
      http(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
      "unreachable",
    ],
    [
      "google",
      http(400, {
        error: {
          code: 400,
          message: "API key not valid.",
          status: "INVALID_ARGUMENT",
          details: [{ reason: "API_KEY_INVALID" }],
        },
      }),
      "invalid-key",
    ],
    [
      "google",
      http(403, { error: { code: 403, status: "PERMISSION_DENIED", message: "denied" } }),
      "invalid-key",
    ],
    [
      "google",
      http(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota" } }),
      "rate-limited",
    ],
    ["openai", http(503, "upstream down"), "unreachable"],
    ["openai", { cause: new TypeError("fetch failed") }, "unreachable"],
    ["openai", { timedOut: true }, "timeout"],
    ["anthropic", new DOMException("The operation timed out.", "TimeoutError"), "timeout"],
  ] as const)("%s %j → %s", (provider, failure, kind) => {
    expect(classifyProviderError(provider, failure).kind).toBe(kind);
  });

  it("says what to do, naming the provider", () => {
    expect(classifyProviderError("anthropic", http(401, {})).message).toBe(
      "Your Anthropic key was rejected. Check it in Settings, or create a new one on Anthropic's site.",
    );
    expect(
      classifyProviderError("openai", http(429, { error: { code: "insufficient_quota" } })).message,
    ).toBe(
      "Your OpenAI account is out of credit. Add credit or raise your spending limit on OpenAI's site.",
    );
    expect(classifyProviderError("google", http(429, {})).message).toBe(
      "Google is limiting requests right now. Wait a minute, then try again.",
    );
    expect(classifyProviderError("openai", { cause: new Error("ECONNRESET") }).message).toBe(
      "OpenAI couldn't be reached. Try again in a moment.",
    );
    expect(classifyProviderError("openai", { timedOut: true }).message).toBe(
      "OpenAI is taking too long. Try again in a moment.",
    );
  });

  it("reads the AI SDK's call errors", () => {
    const sdkError = Object.assign(new Error("Unauthorized"), {
      name: "AI_APICallError",
      statusCode: 401,
      responseBody: JSON.stringify({ error: { code: "invalid_api_key" } }),
    });
    expect(classifyProviderError("openai", sdkError).kind).toBe("invalid-key");
  });
});
