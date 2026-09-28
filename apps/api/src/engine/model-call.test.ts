import { joinSystemPrompt, type SystemPrompt } from "@grounded/core";
import { credentials, usageEvents, users } from "@grounded/db";
import { generateText, simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4GenerateResult, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { APICallError } from "@ai-sdk/provider";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "../test/harness.js";
import type { CallLimits } from "./call-limits.js";
import { systemMessages } from "./call-options.js";
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

function callerWith(model: MockLanguageModelV4, limits?: CallLimits) {
  const built: { provider: string; modelId: string; apiKey: string }[] = [];
  const caller = createModelCaller({
    db: t.db,
    vault: t.vault,
    createLanguageModel: (provider, modelId, apiKey) => {
      built.push({ provider, modelId, apiKey });
      return model;
    },
    ...(limits ? { limitsFor: () => limits, retryDelayMs: 5 } : {}),
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

/** Small limits, so a hung call fails in milliseconds. */
const tight: CallLimits = { generateMs: 150, streamMs: 3000, thinkMs: 500, idleMs: 60 };
/** A model call that never answers and ignores its abort signal, as a hung connection can. */
const never = () => new Promise<never>(() => undefined);
const networkError = () =>
  new APICallError({
    message: "Cannot connect to API: fetch failed",
    url: "https://api.openai.com/v1/responses",
    requestBodyValues: {},
    isRetryable: true,
  });

/** A stream that sends the given parts, pausing where a number stands, then closes or stays open. */
function paced(script: (LanguageModelV4StreamPart | number)[], end: "close" | "hang") {
  return new ReadableStream<LanguageModelV4StreamPart>({
    async start(controller) {
      for (const step of script) {
        if (typeof step === "number") await sleep(step);
        else controller.enqueue(step);
      }
      if (end === "close") controller.close();
    },
  });
}

async function streamParts(result: ReturnType<typeof streamText>) {
  const parts: { type: string; error?: unknown }[] = [];
  for await (const part of result.stream) parts.push(part);
  return parts;
}

describe("model call time limits", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails a hung call with the plain message, records it and logs it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const userId = await userWithKey("openai", "gpt-6-luna");
    const hung = new MockLanguageModelV4({ doGenerate: never });
    const { caller } = callerWith(hung, tight);
    const model = await caller.model({ userId, purpose: "probe", role: "strong" });

    const started = Date.now();
    const error = await generateText({ model, prompt: "decide" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderCallError);
    expect(error).toMatchObject({
      kind: "timeout",
      message: "OpenAI is taking too long. Try again in a moment.",
    });
    expect(Date.now() - started).toBeLessThan(1000);
    // Nothing waits again: a timeout is not retried.
    expect(hung.doGenerateCalls).toHaveLength(1);
    const events = await t.db.select().from(usageEvents);
    expect(events.map((e) => [e.purpose, e.status, e.errorKind])).toEqual([
      ["probe", "error", "timeout"],
    ]);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^model call failed: openai\/gpt-6-luna \(probe\) after \d+\.\d s → timeout: /,
      ),
    );
  });

  it("gives a retry after a network error only the time left, then fails plainly", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const userId = await userWithKey("openai", "gpt-6-luna");
    let calls = 0;
    const flaky = new MockLanguageModelV4({
      doGenerate: () => (++calls === 1 ? Promise.reject(networkError()) : never()),
    });
    const { caller } = callerWith(flaky, tight);
    const model = await caller.model({ userId, purpose: "probe", role: "strong" });

    const started = Date.now();
    const error = await generateText({ model, prompt: "decide" }).catch((e: unknown) => e);

    // A ProviderCallError rather than the SDK's RetryError, so the jobs show its message.
    expect(error).toBeInstanceOf(ProviderCallError);
    expect(error).toMatchObject({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(tight.generateMs + 500);
    expect(calls).toBe(2);
    const events = await t.db.select().from(usageEvents);
    expect(events.map((e) => e.errorKind)).toEqual(["unreachable", "timeout"]);
  });

  it("still retries a network error that the next attempt recovers from", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const userId = await userWithKey("openai", "gpt-6-luna");
    let calls = 0;
    const flaky = new MockLanguageModelV4({
      doGenerate: () =>
        ++calls === 1 ? Promise.reject(networkError()) : Promise.resolve(reply("Recovered.")),
    });
    const { caller } = callerWith(flaky, tight);
    const model = await caller.model({ userId, purpose: "check", role: "strong" });

    const result = await generateText({ model, prompt: "grade" });

    expect(result.text).toBe("Recovered.");
    const events = await t.db.select().from(usageEvents);
    expect(events.map((e) => e.status)).toEqual(["error", "ok"]);
  });

  it("leaves a call that answers in time alone, and stops its timers", async () => {
    const userId = await userWithKey("openai", "gpt-6-luna");
    const quick = new MockLanguageModelV4({ doGenerate: reply("Done.") });
    const { caller } = callerWith(quick, tight);
    const model = await caller.model({ userId, purpose: "check", role: "strong" });

    const result = await generateText({ model, prompt: "grade" });
    await sleep(tight.generateMs * 2);

    expect(result.text).toBe("Done.");
    expect(quick.doGenerateCalls[0]?.abortSignal?.aborted).toBe(false);
    const events = await t.db.select().from(usageEvents);
    expect(events.map((e) => e.status)).toEqual(["ok"]);
  });

  it("lets the caller's own abort through, unchanged and at once", async () => {
    const userId = await userWithKey("openai", "gpt-6-luna");
    const hung = new MockLanguageModelV4({ doGenerate: never });
    const { caller } = callerWith(hung, { ...tight, generateMs: 60_000 });
    const model = await caller.model({ userId, purpose: "aside", role: "cheap" });
    const abort = new AbortController();

    const started = Date.now();
    setTimeout(() => {
      abort.abort();
    }, 20);
    const error = await generateText({ model, prompt: "hi", abortSignal: abort.signal }).catch(
      (e: unknown) => e,
    );

    expect(error).not.toBeInstanceOf(ProviderCallError);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(hung.doGenerateCalls[0]?.abortSignal?.aborted).toBe(true);
    expect(await t.db.select().from(usageEvents)).toEqual([]);
  });

  it("fails a stream that stalls between chunks", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const userId = await userWithKey("anthropic", "claude-opus-5-5");
    const stalling = new MockLanguageModelV4({
      doStream: {
        stream: paced(
          [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "The first half" },
          ],
          "hang",
        ),
      },
    });
    const { caller } = callerWith(stalling, tight);
    const model = await caller.model({ userId, purpose: "lesson", role: "strong" });

    const started = Date.now();
    const parts = await streamParts(streamText({ model, prompt: "write" }));

    const failure = parts.find((p) => p.type === "error");
    expect(failure?.error).toBeInstanceOf(ProviderCallError);
    expect(failure?.error).toMatchObject({
      kind: "timeout",
      message: "Anthropic is taking too long. Try again in a moment.",
    });
    // The idle limit fired, not the longer thinking limit.
    expect(Date.now() - started).toBeLessThan(tight.thinkMs);
    expect(stalling.doStreamCalls[0]?.abortSignal?.aborted).toBe(true);
    const events = await t.db.select().from(usageEvents);
    expect(events.map((e) => [e.purpose, e.status, e.errorKind])).toEqual([
      ["lesson", "error", "timeout"],
    ]);
  });

  it("fails a stream that never starts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const userId = await userWithKey("openai", "gpt-6-luna");
    const silent = new MockLanguageModelV4({ doStream: never });
    const { caller } = callerWith(silent, tight);
    const model = await caller.model({ userId, purpose: "aside", role: "cheap" });

    const parts = await streamParts(streamText({ model, prompt: "hi" }));

    expect(parts.find((p) => p.type === "error")?.error).toMatchObject({ kind: "timeout" });
    expect(silent.doStreamCalls).toHaveLength(1);
  });

  it("allows longer silence between outputs, where the model reasons or searches unseen", async () => {
    const userId = await userWithKey("openai", "gpt-6-luna");
    const thinking = new MockLanguageModelV4({
      doStream: {
        stream: paced(
          [
            { type: "stream-start", warnings: [] },
            { type: "reasoning-start", id: "r" },
            // Longer than the idle limit, within the thinking limit.
            tight.idleMs + 40,
            { type: "reasoning-end", id: "r" },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "Thought it through." },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: finish, usage },
          ],
          "close",
        ),
      },
    });
    const { caller } = callerWith(thinking, tight);
    const model = await caller.model({ userId, purpose: "probe", role: "strong" });

    const result = streamText({ model, prompt: "hi" });

    expect(await result.text).toBe("Thought it through.");
    const events = await t.db.select().from(usageEvents);
    expect(events.map((e) => e.status)).toEqual(["ok"]);
  });
});

describe("provider cache hints", () => {
  const prompt: SystemPrompt = {
    method: "# Teaching method\n\nThe rules.",
    track: "# What the app gives you in this call\n\n## Track\n\nSubject: Concurrency",
    call: "## The step being checked\n\nStep one.",
  };
  const streamed = () =>
    new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "Next question." },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: finish, usage },
          ] satisfies LanguageModelV4StreamPart[],
        }),
      },
    });

  it("gives OpenAI the track as its cache key, and the system prompt as one message", async () => {
    const userId = await userWithKey("openai", "gpt-6-luna");
    const mock = new MockLanguageModelV4({ doGenerate: reply("ok") });
    const { caller } = callerWith(mock);
    const model = await caller.model({ userId, purpose: "check", role: "strong", trackId: "t-1" });

    await generateText({ model, system: systemMessages(prompt), prompt: "grade" });

    const [call] = mock.doGenerateCalls;
    expect(call?.providerOptions).toEqual({ openai: { promptCacheKey: "t-1" } });
    expect(call?.prompt.filter((m) => m.role === "system")).toEqual([
      { role: "system", content: joinSystemPrompt(prompt) },
    ]);
  });

  it("sets no cache key for a call about no track", async () => {
    const userId = await userWithKey("openai", "gpt-6-luna");
    const mock = new MockLanguageModelV4({ doGenerate: reply("ok") });
    const { caller } = callerWith(mock);
    const model = await caller.model({ userId, purpose: "import", role: "strong" });

    await generateText({ model, prompt: "read" });

    expect(mock.doGenerateCalls[0]?.providerOptions).toEqual({});
  });

  it("marks Anthropic cache breakpoints after the method and the track, and caches the conversation", async () => {
    const userId = await userWithKey("anthropic", "claude-opus-5-5");
    const mock = streamed();
    const { caller } = callerWith(mock);
    const model = await caller.model({ userId, purpose: "probe", role: "strong", trackId: "t-1" });

    await streamText({ model, system: systemMessages(prompt), prompt: "hi" }).text;

    const [call] = mock.doStreamCalls;
    const breakpoint = { anthropic: { cacheControl: { type: "ephemeral" } } };
    expect(call?.providerOptions).toEqual(breakpoint);
    const system = call?.prompt.filter((m) => m.role === "system") ?? [];
    expect(system).toEqual([
      { role: "system", content: `${prompt.method}\n\n`, providerOptions: breakpoint },
      { role: "system", content: `${prompt.track}\n\n`, providerOptions: breakpoint },
      { role: "system", content: prompt.call },
    ]);
    // Read as one text, the blocks are exactly the assembled prompt.
    expect(system.map((m) => m.content).join("")).toBe(joinSystemPrompt(prompt));
  });

  it("lets the caller's own provider options win", async () => {
    const userId = await userWithKey("openai", "gpt-6-luna");
    const mock = new MockLanguageModelV4({ doGenerate: reply("ok") });
    const { caller } = callerWith(mock);
    const model = await caller.model({ userId, purpose: "check", role: "strong", trackId: "t-1" });

    await generateText({
      model,
      prompt: "grade",
      providerOptions: { openai: { promptCacheKey: "mine", store: false } },
    });

    expect(mock.doGenerateCalls[0]?.providerOptions).toEqual({
      openai: { promptCacheKey: "mine", store: false },
    });
  });
});
