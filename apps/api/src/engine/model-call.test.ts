import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { initialSession, joinSystemPrompt, type SystemPrompt } from "@grounded/core";
import {
  credentials,
  eq,
  learningSessions,
  modelCalls,
  tracks,
  usageEvents,
  users,
} from "@grounded/db";
import { generateText, Output, simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  type LanguageModelV4GenerateResult,
  type LanguageModelV4StreamPart,
  APICallError,
} from "@ai-sdk/provider";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { captureLogs } from "../log.js";
import { createTestHarness } from "../test/harness.js";
import type { CallLimits } from "./call-limits.js";
import { systemMessages } from "./call-options.js";
import { traced, verdictIssues } from "./call-trace.js";
import { createModelCaller, NoCredentialError, ProviderCallError } from "./model-call.js";

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

async function userWithKey(provider: "openai" | "anthropic" | "deepseek", model: string) {
  const [user] = await t.db.insert(users).values({ email: "ada@example.com" }).returning();
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

/** A track of the learner's, for calls made about one. */
async function trackOf(userId: string) {
  const [track] = await t.db
    .insert(tracks)
    .values({ userId, title: "Concurrency", goal: "Concurrency" })
    .returning();
  if (!track) throw new Error("no track");
  return track.id;
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
  it("builds the model with the decrypted key, records the call's usage and logs it", async () => {
    const logs = captureLogs();
    onTestFinished(logs.restore);
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
    const [line] = logs.lines.filter((l) => l.message === "model call");
    expect(line).toMatchObject({
      level: "info",
      userId,
      purpose: "probe",
      role: "strong",
      provider: "openai",
      model: "gpt-6-luna",
      inputTokens: 1200,
      cachedInputTokens: 1000,
      outputTokens: 80,
      durationMs: events[0]?.durationMs,
    });
    expect(logs.text()).not.toContain("sk-secret-1234");
  });

  it("records the method version the call was made under and the release it ran in", async () => {
    const userId = await userWithKey("openai", "gpt-6-luna");
    const model = new MockLanguageModelV4({ doGenerate: reply("Got it.") });
    const released = createModelCaller({
      db: t.db,
      vault: t.vault,
      createLanguageModel: () => model,
      release: "abc123",
    });
    await generateText({
      model: await released.model({
        userId,
        purpose: "probe",
        role: "strong",
        methodVersion: "0123456789ab",
      }),
      prompt: "hi",
    });
    await generateText({
      model: await callerWith(model).caller.model({ userId, purpose: "import", role: "strong" }),
      prompt: "hi",
    });

    const events = await t.db.select().from(usageEvents).orderBy(usageEvents.purpose);
    expect(events.map((e) => [e.purpose, e.methodVersion, e.release])).toEqual([
      ["import", null, null],
      ["probe", "0123456789ab", "abc123"],
    ]);
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

  it("records the track and session a call was made for, and what it wrote to the cache", async () => {
    const userId = await userWithKey("anthropic", "claude-opus-5-5");
    const trackId = await trackOf(userId);
    const [session] = await t.db
      .insert(learningSessions)
      .values({ trackId, userId, state: initialSession() })
      .returning();
    const written = {
      ...usage,
      inputTokens: { total: 1500, noCache: 200, cacheRead: 1000, cacheWrite: 300 },
    };
    const { caller } = callerWith(
      new MockLanguageModelV4({ doGenerate: { ...reply("Next."), usage: written } }),
    );

    const model = await caller.model({
      userId,
      trackId,
      sessionId: session?.id ?? "",
      purpose: "check",
      role: "strong",
    });
    await generateText({ model, prompt: "grade" });
    await generateText({
      model: await caller.model({ userId, purpose: "import", role: "strong" }),
      prompt: "import",
    });

    const events = await t.db.select().from(usageEvents).orderBy(usageEvents.purpose);
    expect(
      events.map((e) => [e.purpose, e.trackId, e.sessionId, e.inputTokens, e.cacheWriteTokens]),
    ).toEqual([
      ["check", trackId, session?.id, 1500, 300],
      ["import", null, null, 1500, 300],
    ]);
  });

  it("turns a provider failure into the plain message, records it and logs its cause", async () => {
    const logs = captureLogs();
    onTestFinished(logs.restore);
    const userId = await userWithKey("openai", "gpt-6-luna");
    const failing = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.reject(
          new APICallError({
            message: "Incorrect API key provided",
            url: "https://api.openai.com/v1/responses",
            // The request holds the prompt, so the learner's words: never logged.
            requestBodyValues: { input: "what the learner wrote" },
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
      notice: { code: "provider-failed", kind: "invalid-key", provider: "OpenAI" },
    });
    const [event] = await t.db.select().from(usageEvents);
    expect(event).toMatchObject({
      purpose: "check",
      inputTokens: 0,
      outputTokens: 0,
      status: "error",
      errorKind: "invalid-key",
    });
    const [line] = logs.lines.filter((l) => l.message === "model call failed");
    expect(line).toMatchObject({
      level: "warn",
      purpose: "check",
      errorKind: "invalid-key",
      err: {
        type: "AI_APICallError",
        message: "Incorrect API key provided",
        status: 401,
        body: JSON.stringify({ error: { code: "invalid_api_key" } }),
      },
    });
    expect(logs.text()).not.toContain("what the learner wrote");
  });

  it("uses the provider's cheap model for the cheap role", async () => {
    const userId = await userWithKey("anthropic", "claude-opus-5-5");
    const { caller, built } = callerWith(new MockLanguageModelV4({ doGenerate: reply("ok") }));
    await caller.model({ userId, purpose: "aside", role: "cheap" });
    expect(built[0]?.modelId).toBe("claude-haiku-4-5-20251001");
  });

  it("asks for a key when the learner has none", async () => {
    const [user] = await t.db.insert(users).values({ email: "bo@example.com" }).returning();
    if (!user) throw new Error("no user");
    const { caller } = callerWith(new MockLanguageModelV4({ doGenerate: reply("ok") }));
    await expect(
      caller.model({ userId: user.id, purpose: "probe", role: "strong" }),
    ).rejects.toBeInstanceOf(NoCredentialError);
  });
});

describe("call content in the log (LOG_CONTENT)", () => {
  const chunks: LanguageModelV4StreamPart[] = [
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", delta: "They want arcs first." },
    { type: "reasoning-end", id: "r" },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "We'll start " },
    { type: "text-delta", id: "t", delta: "with arcs." },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: finish, usage },
  ];
  const streamed = async (userId: string) => {
    const { caller } = callerWith(
      new MockLanguageModelV4({ doStream: { stream: simulateReadableStream({ chunks }) } }),
    );
    const result = streamText({
      model: await caller.model({ userId, purpose: "plan", role: "strong" }),
      system: "the method",
      messages: [
        { role: "user", content: "teach me" },
        { role: "assistant", content: "what do you know?" },
        { role: "user", content: "Present the corrected plan." },
      ],
    });
    await result.text;
  };

  it("gives each call's last turn and its reply, when on", async () => {
    const logs = captureLogs("trace", { withContent: true });
    onTestFinished(logs.restore);
    const userId = await userWithKey("openai", "gpt-6-luna");

    const { caller } = callerWith(new MockLanguageModelV4({ doGenerate: reply('{"actions":[]}') }));
    await generateText({
      model: await caller.model({ userId, purpose: "plan", role: "strong" }),
      prompt: "(For the app) Record the plan.",
      output: Output.object({ schema: z.object({ actions: z.array(z.string()) }) }),
    });
    await streamed(userId);

    expect(logs.lines.filter((l) => l.message === "model call").map((l) => l.content)).toEqual([
      {
        messages: 1,
        lastTurn: { role: "user", text: "(For the app) Record the plan." },
        json: true,
        reply: { text: '{"actions":[]}' },
      },
      {
        messages: 4,
        lastTurn: { role: "user", text: "Present the corrected plan." },
        json: false,
        reply: { text: "We'll start with arcs.", reasoning: "They want arcs first." },
      },
    ]);
  });

  it("gives none of it when off", async () => {
    const logs = captureLogs();
    onTestFinished(logs.restore);
    const userId = await userWithKey("openai", "gpt-6-luna");
    await streamed(userId);

    expect(logs.lines.filter((l) => l.message === "model call")).toHaveLength(1);
    expect(logs.text()).not.toMatch(/corrected plan|arcs/);
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
  it("fails a hung call with the plain message, records it and logs it", async () => {
    const logs = captureLogs();
    onTestFinished(logs.restore);
    const userId = await userWithKey("openai", "gpt-6-luna");
    const hung = new MockLanguageModelV4({ doGenerate: never });
    const { caller } = callerWith(hung, tight);
    const model = await caller.model({ userId, purpose: "probe", role: "strong" });

    const started = Date.now();
    const error = await generateText({ model, prompt: "decide" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderCallError);
    expect(error).toMatchObject({
      kind: "timeout",
      notice: { code: "provider-failed", kind: "timeout", provider: "OpenAI" },
    });
    expect(Date.now() - started).toBeLessThan(1000);
    // Nothing waits again: a timeout is not retried.
    expect(hung.doGenerateCalls).toHaveLength(1);
    const events = await t.db.select().from(usageEvents);
    expect(events.map((e) => [e.purpose, e.status, e.errorKind])).toEqual([
      ["probe", "error", "timeout"],
    ]);
    expect(logs.lines.filter((l) => l.message === "model call failed")).toEqual([
      expect.objectContaining({
        provider: "openai",
        model: "gpt-6-luna",
        purpose: "probe",
        errorKind: "timeout",
        elapsedMs: expect.any(Number) as number,
        durationMs: events[0]?.durationMs,
      }),
    ]);
  });

  it("gives a retry after a network error only the time left, then fails plainly", async () => {
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
      notice: { code: "provider-failed", kind: "timeout", provider: "Anthropic" },
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

describe("call duration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records how long a call took, each attempt on its own", async () => {
    const userId = await userWithKey("openai", "gpt-6-luna");
    // A clock the model moves: the first attempt takes 1 s and fails, the retry takes 2 s.
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let calls = 0;
    const slow = new MockLanguageModelV4({
      doGenerate: () => {
        if (++calls === 1) {
          now += 1000;
          return Promise.reject(networkError());
        }
        now += 2000;
        return Promise.resolve(reply("Done."));
      },
    });
    const { caller } = callerWith(slow, { ...tight, generateMs: 60_000 });
    const model = await caller.model({ userId, purpose: "check", role: "strong" });

    await generateText({ model, prompt: "grade" });

    const events = await t.db.select().from(usageEvents);
    // The retry's own time, not counting the first attempt's.
    expect(events.map((e) => [e.status, e.durationMs]).sort()).toEqual([
      ["error", 1000],
      ["ok", 2000],
    ]);
  });

  it("records a stream's time up to its finish", async () => {
    const userId = await userWithKey("openai", "gpt-6-luna");
    const streaming = new MockLanguageModelV4({
      // Built when the call starts, so its pause falls inside the call.
      doStream: () =>
        Promise.resolve({
          stream: paced(
            [
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "One" },
              40,
              { type: "text-delta", id: "t", delta: " two." },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: finish, usage },
            ],
            "close",
          ),
        }),
    });
    const { caller } = callerWith(streaming);
    const model = await caller.model({ userId, purpose: "probe", role: "strong" });

    expect(await streamText({ model, prompt: "hi" }).text).toBe("One two.");

    const [event] = await t.db.select().from(usageEvents);
    expect(event?.durationMs).toBeGreaterThanOrEqual(35);
  });
});

describe("reasoning effort per purpose", () => {
  it("thinks little for the small structured records, and leaves every other call at the default", async () => {
    const userId = await userWithKey("openai", "gpt-6-luna");
    const efforts: Record<string, unknown> = {};
    for (const purpose of [
      "probe-decision",
      "term-sweep",
      "probe",
      "probe-summary",
      "plan",
      "lesson",
      "check",
    ]) {
      const mock = new MockLanguageModelV4({ doGenerate: reply("{}") });
      const { caller } = callerWith(mock);
      const model = await caller.model({
        userId,
        purpose,
        role: "strong",
        trackId: await trackOf(userId),
      });
      await generateText({ model, prompt: "decide" });
      efforts[purpose] = mock.doGenerateCalls[0]?.reasoning;
    }
    expect(efforts).toEqual({
      "probe-decision": "low",
      "term-sweep": "low",
      probe: undefined,
      "probe-summary": undefined,
      plan: undefined,
      lesson: undefined,
      check: undefined,
    });
  });

  it("lets the caller's own reasoning setting win", async () => {
    const userId = await userWithKey("anthropic", "claude-opus-5-5");
    const mock = new MockLanguageModelV4({ doGenerate: reply("{}") });
    const { caller } = callerWith(mock);
    const model = await caller.model({ userId, purpose: "probe-decision", role: "strong" });

    await generateText({ model, prompt: "decide", reasoning: "high" });

    expect(mock.doGenerateCalls[0]?.reasoning).toBe("high");
  });
});

describe("provider cache hints", () => {
  const prompt: SystemPrompt = {
    sharedMethod: "# Teaching method\n\nThe rules.",
    phaseMethod: "## Checks\n\nHow to grade.",
    track: "# What the app gives you in this call\n\n## Track\n\nSubject: Concurrency",
    call: "## The step being checked\n\nStep one.",
  };
  /** The mark on a stable part, in each provider's form; a provider's SDK reads its own. */
  const MARK = {
    anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
    openai: { promptCacheBreakpoint: { mode: "explicit" } },
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

  it("gives OpenAI the track as its cache key, and the system prompt's parts as separate messages with their marks", async () => {
    const userId = await userWithKey("openai", "gpt-6-luna");
    const mock = new MockLanguageModelV4({ doGenerate: reply("ok") });
    const { caller } = callerWith(mock);
    const trackId = await trackOf(userId);
    const model = await caller.model({ userId, purpose: "check", role: "strong", trackId });

    await generateText({ model, system: systemMessages(prompt), prompt: "grade" });

    const [call] = mock.doGenerateCalls;
    expect(call?.providerOptions).toEqual({ openai: { promptCacheKey: trackId } });
    expect(call?.prompt.filter((m) => m.role === "system")).toEqual([
      { role: "system", content: prompt.sharedMethod, providerOptions: MARK },
      { role: "system", content: prompt.phaseMethod, providerOptions: MARK },
      { role: "system", content: prompt.track, providerOptions: MARK },
      { role: "system", content: prompt.call },
    ]);
  });

  it("joins the system prompt's parts into one message for a provider that caches implicitly", async () => {
    const userId = await userWithKey("deepseek", "deepseek-flash");
    const mock = new MockLanguageModelV4({ doGenerate: reply("ok") });
    const { caller } = callerWith(mock);
    const model = await caller.model({ userId, purpose: "check", role: "strong" });

    await generateText({ model, system: systemMessages(prompt), prompt: "grade" });

    expect(mock.doGenerateCalls[0]?.prompt.filter((m) => m.role === "system")).toEqual([
      { role: "system", content: joinSystemPrompt(prompt) },
    ]);
  });

  describe("as OpenAI receives them", () => {
    /** The request bodies @ai-sdk/openai sends, through a fetch that answers in place of the API. */
    function openaiRequests() {
      const bodies: Record<string, unknown>[] = [];
      const fetch = (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
        const response = {
          id: "resp_1",
          object: "response",
          created_at: 0,
          status: "completed",
          model: "gpt-6-luna",
          output: [
            {
              type: "message",
              id: "msg_1",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "ok", annotations: [] }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
        };
        return Promise.resolve(
          new Response(JSON.stringify(response), {
            headers: { "content-type": "application/json" },
          }),
        );
      };
      const caller = createModelCaller({
        db: t.db,
        vault: t.vault,
        createLanguageModel: (_provider, modelId, apiKey) =>
          createOpenAI({ apiKey, fetch })(modelId),
      });
      return { caller, bodies };
    }

    /** Each input message's text blocks with their breakpoint, or the message's plain text. */
    const inputOf = (body: Record<string, unknown>) =>
      (body.input as { role: string; content: unknown }[]).map(({ role, content }) => ({
        role,
        content,
      }));

    it("marks an explicit breakpoint after each stable part, none after the call's own, and keeps the implicit one", async () => {
      const userId = await userWithKey("openai", "gpt-6-luna");
      const { caller, bodies } = openaiRequests();
      const trackId = await trackOf(userId);
      const model = await caller.model({ userId, purpose: "check", role: "strong", trackId });

      await generateText({ model, system: systemMessages(prompt), prompt: "grade" });

      const breakpoint = { mode: "explicit" };
      const block = (text: string) => [
        { type: "input_text", text, prompt_cache_breakpoint: breakpoint },
      ];
      expect(inputOf(bodies[0] ?? {})).toEqual([
        { role: "developer", content: block(prompt.sharedMethod) },
        { role: "developer", content: block(prompt.phaseMethod) },
        { role: "developer", content: block(prompt.track) },
        { role: "developer", content: prompt.call },
        { role: "user", content: [{ type: "input_text", text: "grade" }] },
      ]);
      expect(bodies[0]?.prompt_cache_key).toBe(trackId);
      // The default mode: OpenAI adds its implicit breakpoint at the end, for the conversation's
      // next call; with the 3 explicit ones that is its 4 cache writes per request at most.
      expect(bodies[0]).not.toHaveProperty("prompt_cache_options");
    });

    it("marks no breakpoint for an empty part", async () => {
      const userId = await userWithKey("openai", "gpt-6-luna");
      const { caller, bodies } = openaiRequests();
      const model = await caller.model({ userId, purpose: "check", role: "strong" });

      await generateText({
        model,
        system: systemMessages({ ...prompt, track: "", call: "" }),
        prompt: "grade",
      });

      expect(inputOf(bodies[0] ?? {}).map((m) => m.role)).toEqual([
        "developer",
        "developer",
        "user",
      ]);
      expect(JSON.stringify(bodies[0]).match(/prompt_cache_breakpoint/g)).toHaveLength(2);
    });
  });

  it("replaces a file the model doesn't read with a line saying so, and keeps the ones it does", async () => {
    const userId = await userWithKey("deepseek", "deepseek-flash");
    const mock = new MockLanguageModelV4({ doGenerate: reply("ok") });
    const { caller } = callerWith(mock);
    const model = await caller.model({ userId, purpose: "track-brief", role: "strong" });
    const bytes = new Uint8Array([1, 2, 3]);

    await generateText({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "They attached these 2 files: cv.pdf, whiteboard.png." },
            { type: "file", data: bytes, mediaType: "application/pdf", filename: "cv.pdf" },
            { type: "file", data: bytes, mediaType: "image/png", filename: "whiteboard.png" },
            { type: "text", text: "Summarize these files." },
          ],
        },
      ],
    });

    const [call] = mock.doGenerateCalls;
    const user = call?.prompt.find((m) => m.role === "user");
    expect(user?.content.map((part) => (part.type === "file" ? part.filename : part.text))).toEqual(
      [
        "They attached these 2 files: cv.pdf, whiteboard.png.",
        '("cv.pdf" was attached here but left out: DeepSeek Flash doesn\'t read PDFs. Ask the learner for what it says if the teaching needs it.)',
        "whiteboard.png",
        "Summarize these files.",
      ],
    );
  });

  it("sets no cache key for a call about no track", async () => {
    const userId = await userWithKey("openai", "gpt-6-luna");
    const mock = new MockLanguageModelV4({ doGenerate: reply("ok") });
    const { caller } = callerWith(mock);
    const model = await caller.model({ userId, purpose: "import", role: "strong" });

    await generateText({ model, prompt: "read" });

    expect(mock.doGenerateCalls[0]?.providerOptions).toEqual({});
  });

  it("marks Anthropic cache breakpoints after the shared method, the phase's method and the track, and caches the conversation", async () => {
    const userId = await userWithKey("anthropic", "claude-opus-5-5");
    const mock = streamed();
    const { caller } = callerWith(mock);
    const model = await caller.model({
      userId,
      purpose: "probe",
      role: "strong",
      trackId: await trackOf(userId),
    });

    await streamText({ model, system: systemMessages(prompt), prompt: "hi" }).text;

    const [call] = mock.doStreamCalls;
    expect(call?.providerOptions).toEqual({ anthropic: MARK.anthropic });
    const system = call?.prompt.filter((m) => m.role === "system") ?? [];
    expect(system).toEqual([
      { role: "system", content: `${prompt.sharedMethod}\n\n`, providerOptions: MARK },
      { role: "system", content: `${prompt.phaseMethod}\n\n`, providerOptions: MARK },
      { role: "system", content: `${prompt.track}\n\n`, providerOptions: MARK },
      { role: "system", content: prompt.call },
    ]);
    // Read as one text, the blocks are exactly the assembled prompt.
    expect(system.map((m) => m.content).join("")).toBe(joinSystemPrompt(prompt));
  });

  describe("as Anthropic receives them", () => {
    /** The request bodies @ai-sdk/anthropic sends, through a fetch that answers in place of the API. */
    function anthropicRequests() {
      const bodies: Record<string, unknown>[] = [];
      const headers: Headers[] = [];
      const fetch = (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
        headers.push(new Headers(init?.headers));
        const message = {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        };
        return Promise.resolve(
          new Response(JSON.stringify(message), {
            headers: { "content-type": "application/json" },
          }),
        );
      };
      const caller = createModelCaller({
        db: t.db,
        vault: t.vault,
        createLanguageModel: (_provider, modelId, apiKey) =>
          createAnthropic({ apiKey, fetch })(modelId),
      });
      return { caller, bodies, headers };
    }

    /** Every cache_control in a request body, the top-level one included. */
    function cacheControls(value: unknown): unknown[] {
      if (Array.isArray(value)) return value.flatMap(cacheControls);
      if (!value || typeof value !== "object") return [];
      return Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) =>
        key === "cache_control" ? [inner] : cacheControls(inner),
      );
    }

    it("sends one breakpoint per stable part and the top-level one, never more than 4", async () => {
      const userId = await userWithKey("anthropic", "claude-opus-5-5");
      const { caller, bodies } = anthropicRequests();
      const model = await caller.model({
        userId,
        purpose: "check",
        role: "strong",
        trackId: await trackOf(userId),
      });
      const cases: [SystemPrompt, number][] = [
        [prompt, 4],
        [{ ...prompt, call: "" }, 4],
        [{ ...prompt, track: "" }, 3],
        [{ ...prompt, phaseMethod: "", track: "", call: "" }, 2],
      ];
      for (const [parts] of cases)
        await generateText({ model, system: systemMessages(parts), prompt: "grade" });

      expect(bodies.map((body) => cacheControls(body).length)).toEqual(cases.map(([, n]) => n));
      for (const [i, [parts]] of cases.entries()) {
        const system = bodies[i]?.system as { text: string }[];
        // Read as one text, the blocks are exactly the assembled prompt.
        expect(system.map((block) => block.text).join("")).toBe(joinSystemPrompt(parts));
        expect(bodies[i]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
      }
    });

    it("caches for an hour at every breakpoint, with no beta header", async () => {
      const userId = await userWithKey("anthropic", "claude-opus-5-5");
      const { caller, bodies, headers } = anthropicRequests();
      const model = await caller.model({
        userId,
        purpose: "check",
        role: "strong",
        trackId: await trackOf(userId),
      });

      await generateText({ model, system: systemMessages(prompt), prompt: "grade" });

      // All the same lifetime, so none outlives one before it (Anthropic requires longer first).
      expect(cacheControls(bodies[0])).toEqual(Array(4).fill({ type: "ephemeral", ttl: "1h" }));
      expect(headers[0]?.get("anthropic-beta")).toBeNull();
    });

    it("leaves out the top-level breakpoint when the prompt's own marks already fill the 4", async () => {
      const userId = await userWithKey("anthropic", "claude-opus-5-5");
      const { caller, bodies } = anthropicRequests();
      const model = await caller.model({
        userId,
        purpose: "check",
        role: "strong",
        trackId: await trackOf(userId),
      });
      const marked = { anthropic: { cacheControl: { type: "ephemeral" } } };

      await generateText({
        model,
        system: ["one", "two", "three", "four"].map((content) => ({
          role: "system" as const,
          content,
          providerOptions: marked,
        })),
        prompt: "grade",
      });

      expect(cacheControls(bodies[0])).toHaveLength(4);
      expect(bodies[0]).not.toHaveProperty("cache_control");
    });
  });

  it("lets the caller's own provider options win", async () => {
    const userId = await userWithKey("openai", "gpt-6-luna");
    const mock = new MockLanguageModelV4({ doGenerate: reply("ok") });
    const { caller } = callerWith(mock);
    const model = await caller.model({
      userId,
      purpose: "check",
      role: "strong",
      trackId: await trackOf(userId),
    });

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

describe("stored calls (model_calls)", () => {
  const storedFor = async (usageEventId: string | undefined) => {
    const [row] = await t.db
      .select()
      .from(modelCalls)
      .where(eq(modelCalls.usageEventId, usageEventId ?? ""));
    return row;
  };

  it("keeps a call in full: the prompt as sent, the response format, the settings and the reply", async () => {
    const userId = await userWithKey("openai", "gpt-6-luna");
    const trackId = await trackOf(userId);
    const [session] = await t.db
      .insert(learningSessions)
      .values({ trackId, userId, state: initialSession() })
      .returning();
    const { caller } = callerWith(
      new MockLanguageModelV4({ doGenerate: reply('{"actions":["plan"]}') }),
    );
    const bytes = new Uint8Array(2048);

    await generateText({
      model: await caller.model({
        userId,
        trackId,
        sessionId: session?.id ?? "",
        purpose: "term-sweep",
        role: "strong",
      }),
      system: "the method",
      messages: [
        { role: "user", content: "teach me" },
        { role: "assistant", content: "what do you know?" },
        {
          role: "user",
          content: [
            { type: "text", text: "Record the sweep." },
            { type: "file", data: bytes, mediaType: "image/png", filename: "board.png" },
          ],
        },
      ],
      output: Output.object({ schema: z.object({ actions: z.array(z.string()) }) }),
    });

    const [event] = await t.db.select().from(usageEvents);
    const stored = await storedFor(event?.id);
    expect(stored).toMatchObject({
      trackId,
      sessionId: session?.id,
      responseFormat: {
        type: "json",
        schema: expect.objectContaining({ type: "object" }) as unknown,
      },
      tools: null,
      // The middleware's own settings, as sent.
      settings: {
        reasoning: "low",
        providerOptions: { openai: { promptCacheKey: trackId } },
      },
      reply: {
        content: [{ type: "text", text: '{"actions":["plan"]}' }],
        finishReason: finish,
      },
      error: null,
      verdict: null,
    });
    expect(stored?.prompt).toEqual([
      { role: "system", content: "the method" },
      { role: "user", content: [{ type: "text", text: "teach me" }] },
      { role: "assistant", content: [{ type: "text", text: "what do you know?" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "Record the sweep." },
          // Named, not copied.
          {
            type: "file",
            filename: "board.png",
            mediaType: "image/png",
            data: { type: "data", bytes: 2048 },
          },
        ],
      },
    ]);
  });

  it("keeps a streamed reply's parts: reasoning, text, and the searches with what they found", async () => {
    const userId = await userWithKey("anthropic", "claude-opus-5-5");
    const chunks: LanguageModelV4StreamPart[] = [
      { type: "reasoning-start", id: "r" },
      { type: "reasoning-delta", id: "r", delta: "Check the date. " },
      { type: "reasoning-delta", id: "r", delta: "Search it." },
      { type: "reasoning-end", id: "r" },
      {
        type: "tool-call",
        toolCallId: "s1",
        toolName: "web_search",
        input: '{"query":"when was the transistor invented"}',
        providerExecuted: true,
      },
      {
        type: "tool-result",
        toolCallId: "s1",
        toolName: "web_search",
        result: [{ url: "https://example.org/transistor", title: "The transistor" }],
      },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "In 1947, " },
      { type: "text-delta", id: "t", delta: "at Bell Labs." },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: finish, usage, providerMetadata: { anthropic: { x: 1 } } },
    ];
    const { caller } = callerWith(
      new MockLanguageModelV4({ doStream: { stream: simulateReadableStream({ chunks }) } }),
    );

    const result = streamText({
      model: await caller.model({ userId, purpose: "research", role: "strong" }),
      prompt: "Check the facts.",
    });
    await result.text;

    const [event] = await t.db.select().from(usageEvents);
    expect((await storedFor(event?.id))?.reply).toEqual({
      content: [
        { type: "reasoning", text: "Check the date. Search it." },
        {
          type: "tool-call",
          toolCallId: "s1",
          toolName: "web_search",
          input: '{"query":"when was the transistor invented"}',
          providerExecuted: true,
        },
        {
          type: "tool-result",
          toolCallId: "s1",
          toolName: "web_search",
          result: [{ url: "https://example.org/transistor", title: "The transistor" }],
        },
        { type: "text", text: "In 1947, at Bell Labs." },
      ],
      finishReason: finish,
      providerMetadata: { anthropic: { x: 1 } },
    });
  });

  it("keeps a failed call's error in full, and a stream that failed part-way as far as it got", async () => {
    const userId = await userWithKey("openai", "gpt-6-luna");
    const failing = new MockLanguageModelV4({
      doGenerate: () =>
        Promise.reject(
          new APICallError({
            message: "Incorrect API key provided",
            url: "https://api.openai.com/v1/responses",
            requestBodyValues: {},
            statusCode: 401,
            responseBody: '{"error":{"code":"invalid_api_key"}}',
            isRetryable: false,
          }),
        ),
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "Half a" },
            { type: "error", error: new Error("overloaded") },
          ] satisfies LanguageModelV4StreamPart[],
        }),
      },
    });
    const { caller } = callerWith(failing);
    const model = await caller.model({ userId, purpose: "check", role: "strong" });

    await generateText({ model, prompt: "grade", maxRetries: 0 }).catch(() => undefined);
    await streamParts(streamText({ model, prompt: "write" }));

    const events = await t.db.select().from(usageEvents).orderBy(usageEvents.createdAt);
    const rows = await Promise.all(events.map((e) => storedFor(e.id)));
    expect(rows.map((row) => [row?.reply, row?.error])).toEqual([
      [
        null,
        {
          type: "AI_APICallError",
          message: "Incorrect API key provided",
          status: 401,
          body: '{"error":{"code":"invalid_api_key"}}',
        },
      ],
      [{ content: [{ type: "text", text: "Half a" }] }, { type: "Error", message: "overloaded" }],
    ]);
  });

  it("records the verdict on the traced call whose reply was validated, and only on it", async () => {
    const userId = await userWithKey("openai", "gpt-6-luna");
    let calls = 0;
    const flaky = new MockLanguageModelV4({
      doGenerate: () =>
        ++calls === 1 ? Promise.reject(networkError()) : Promise.resolve(reply("Draft.")),
    });
    const { caller } = callerWith(flaky, tight);
    const model = await caller.model({ userId, purpose: "plan", role: "strong" });

    const draft = await traced(() => generateText({ model, prompt: "write" }));
    await generateText({ model, prompt: "untraced" });
    await draft.judge({
      rewrite: 0,
      issues: verdictIssues([{ code: "term/unknown", message: "Uses a term not taught." }]),
    });

    const events = await t.db.select().from(usageEvents).orderBy(usageEvents.createdAt);
    const rows = await Promise.all(events.map((e) => storedFor(e.id)));
    // The failed attempt, the draft that answered after it, and the untraced call.
    expect(rows.map((row) => row?.verdict)).toEqual([
      null,
      { rewrite: 0, issues: [{ code: "term/unknown", message: "Uses a term not taught." }] },
      null,
    ]);
  });

  it("goes with its track, while the call's usage stays", async () => {
    const userId = await userWithKey("openai", "gpt-6-luna");
    const trackId = await trackOf(userId);
    const { caller } = callerWith(new MockLanguageModelV4({ doGenerate: reply("Named.") }));
    await generateText({
      model: await caller.model({ userId, trackId, purpose: "track-name", role: "cheap" }),
      prompt: "name it",
    });
    await generateText({
      model: await caller.model({ userId, purpose: "import", role: "strong" }),
      prompt: "read",
    });
    expect(await t.db.select().from(modelCalls)).toHaveLength(2);

    await t.db.delete(tracks).where(eq(tracks.id, trackId));

    expect(await t.db.select().from(usageEvents)).toHaveLength(2);
    expect((await t.db.select().from(modelCalls)).map((row) => row.trackId)).toEqual([null]);
  });

  it("stores nothing of a call whose track was deleted while it ran, and still records its usage", async () => {
    const logs = captureLogs();
    onTestFinished(logs.restore);
    const userId = await userWithKey("openai", "gpt-6-luna");
    const trackId = await trackOf(userId);
    const { caller } = callerWith(
      new MockLanguageModelV4({
        doGenerate: async () => {
          await t.db.delete(tracks).where(eq(tracks.id, trackId));
          return reply("Too late.");
        },
      }),
    );

    const result = await generateText({
      model: await caller.model({ userId, trackId, purpose: "track-name", role: "cheap" }),
      prompt: "name it",
    });

    expect(result.text).toBe("Too late.");
    expect(await t.db.select().from(usageEvents)).toHaveLength(1);
    expect(await t.db.select().from(modelCalls)).toEqual([]);
    expect(logs.lines.filter((l) => l.level === "error")).toEqual([]);
  });

  it("keeps text Postgres can't hold as close as it can", async () => {
    const userId = await userWithKey("openai", "gpt-6-luna");
    const { caller } = callerWith(new MockLanguageModelV4({ doGenerate: reply("a\u0000b") }));
    await generateText({
      model: await caller.model({ userId, purpose: "probe", role: "strong" }),
      prompt: "x\u0000y",
    });

    const [row] = await t.db.select().from(modelCalls);
    expect(row?.reply?.content).toEqual([{ type: "text", text: "a�b" }]);
    expect(JSON.stringify(row?.prompt)).toContain("x�y");
  });
});
