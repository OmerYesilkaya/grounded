import { credentials, usageEvents, users } from "@grounded/db";
import { generateText, simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4GenerateResult, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { APICallError } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.js";
import { createModelCaller, ProviderCallError } from "./model-call.js";

const t = createTestHarness();

const usage = {
  inputTokens: { total: 1200, noCache: 200, cacheRead: 1000, cacheWrite: 0 },
  outputTokens: { total: 80, text: 80, reasoning: 0 },
};
const finish = { unified: "stop", raw: "stop" } as const;
const reply = (text: string): LanguageModelV4GenerateResult => ({
  content: [{ type: "text", text }],
  finishReason: finish,
  usage,
  warnings: [],
});

async function userWithKey(provider: "openai" | "anthropic", model: string) {
  const [user] = await t.db
    .insert(users)
    .values({ name: "Ada", email: "ada@example.com" })
    .returning();
  if (!user) throw new Error("no user");
  await t.db.insert(credentials).values({
    userId: user.id,
    provider,
    model,
    sealedKey: t.vault.seal("sk-secret-1234", user.id),
    keyHint: "1234",
  });
  return user.id;
}

function callerWith(model: MockLanguageModelV4) {
  const built: { provider: string; modelId: string; apiKey: string }[] = [];
  const caller = createModelCaller({
    db: t.db,
    vault: t.vault,
    createLanguageModel: (provider, modelId, apiKey) => {
      built.push({ provider, modelId, apiKey });
      return model;
    },
  });
  return { caller, built };
}

describe("callModel", () => {
  it("builds the model with the decrypted key and records the call's usage", async () => {
    const userId = await userWithKey("openai", "gpt-6-luna");
    const { caller, built } = callerWith(
      new MockLanguageModelV4({ doGenerate: reply("Got it. Next one.") }),
    );

    const model = await caller.model({ userId, purpose: "probe", role: "strong" });
    const result = await generateText({ model, prompt: "hi" });

    expect(result.text).toBe("Got it. Next one.");
    expect(built).toEqual([
      { provider: "openai", modelId: "gpt-6-luna", apiKey: "sk-secret-1234" },
    ]);
    const events = await t.db.select().from(usageEvents);
    expect(
      events.map((e) => [
        e.provider,
        e.model,
        e.purpose,
        e.inputTokens,
        e.cachedInputTokens,
        e.outputTokens,
        e.status,
      ]),
    ).toEqual([["openai", "gpt-6-luna", "probe", 1200, 1000, 80, "ok"]]);
  });

  it("records usage for streamed calls when the stream finishes", async () => {
    const userId = await userWithKey("openai", "gpt-6-luna");
    const chunks: LanguageModelV4StreamPart[] = [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "## Adding one" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: finish, usage },
    ];
    const { caller } = callerWith(
      new MockLanguageModelV4({ doStream: { stream: simulateReadableStream({ chunks }) } }),
    );

    const result = streamText({
      model: await caller.model({ userId, purpose: "lesson", role: "strong" }),
      prompt: "write",
    });
    expect(await result.text).toBe("## Adding one");
    const [event] = await t.db.select().from(usageEvents);
    expect(event).toMatchObject({
      purpose: "lesson",
      inputTokens: 1200,
      outputTokens: 80,
      status: "ok",
    });
  });

  it("turns a provider failure into the plain message and records the failed call", async () => {
    const userId = await userWithKey("openai", "gpt-6-luna");
    const failing = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.reject(
          new APICallError({
            message: "Incorrect API key provided",
            url: "https://api.openai.com/v1/responses",
            requestBodyValues: {},
            statusCode: 401,
            responseBody: JSON.stringify({ error: { code: "invalid_api_key" } }),
            isRetryable: false,
          }),
        ),
    });
    const { caller } = callerWith(failing);
    const model = await caller.model({ userId, purpose: "check", role: "strong" });

    const error = await generateText({ model, prompt: "grade", maxRetries: 0 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProviderCallError);
    expect(error).toMatchObject({
      kind: "invalid-key",
      message:
        "Your OpenAI key was rejected. Check it in Settings, or create a new one on OpenAI's site.",
    });
    const [event] = await t.db.select().from(usageEvents);
    expect(event).toMatchObject({
      purpose: "check",
      inputTokens: 0,
      outputTokens: 0,
      status: "error",
      errorKind: "invalid-key",
    });
  });

  it("uses the provider's cheap model for the cheap role", async () => {
    const userId = await userWithKey("anthropic", "claude-opus-5-5");
    const { caller, built } = callerWith(new MockLanguageModelV4({ doGenerate: reply("ok") }));
    await caller.model({ userId, purpose: "aside", role: "cheap" });
    expect(built[0]?.modelId).toBe("claude-haiku-4-5-20251001");
  });

  it("asks for a key when the learner has none", async () => {
    const [user] = await t.db
      .insert(users)
      .values({ name: "Bo", email: "bo@example.com" })
      .returning();
    if (!user) throw new Error("no user");
    const { caller } = callerWith(new MockLanguageModelV4({ doGenerate: reply("ok") }));
    await expect(
      caller.model({ userId: user.id, purpose: "probe", role: "strong" }),
    ).rejects.toThrow("Add your AI key in Settings first.");
  });
});
