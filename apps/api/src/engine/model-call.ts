import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import type { Cause } from "@grounded/core";
import type { KeyVault } from "@grounded/crypto";
import { credentials, eq, modelCalls, sql, usageEvents, type Db } from "@grounded/db";
import {
  cheapModelFor,
  classifyProviderError,
  createSearchTool,
  type ProviderErrorKind,
  type ProviderId,
} from "@grounded/providers";
import { APICallError, RetryError, wrapLanguageModel, type Tool } from "ai";
import { content, log } from "../log.js";
import {
  describePrompt,
  describeReply,
  ReplyCollector,
  storedError,
  storedReply,
  storedRequest,
  type Reply,
} from "./call-content.js";
import {
  CALL_RETRIES,
  callLimitsFor,
  Deadline,
  silenceAfter,
  type CallLimits,
} from "./call-limits.js";
import { shapeCall } from "./call-options.js";
import { currentTrace, type Trace } from "./call-trace.js";

/**
 * A provider failure (design §4.4), with what the learner is told: a notice the web words in the
 * app's language (design §9.3).
 */
export class ProviderCallError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    readonly notice: Cause,
  ) {
    super(notice.code === "provider-failed" ? `${notice.provider}: ${kind}` : notice.code);
    this.name = "ProviderCallError";
  }
}

export class NoCredentialError extends Error {
  readonly notice: Cause = { code: "no-credential" };
  constructor() {
    super("no credential");
    this.name = "NoCredentialError";
  }
}

/** What the learner is told of a failed model call, or null for a failure that isn't theirs. */
export function causeOf(error: unknown): Cause | null {
  return error instanceof ProviderCallError || error instanceof NoCredentialError
    ? error.notice
    : null;
}

/** Turns any failure of a model call into a ProviderCallError, unwrapping the SDK's retry wrapper. */
export function providerErrorFrom(provider: ProviderId, error: unknown): ProviderCallError {
  if (error instanceof ProviderCallError) return error;
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  const { kind, provider: name } = classifyProviderError(provider, cause);
  return new ProviderCallError(kind, { code: "provider-failed", kind, provider: name });
}

export interface ModelCallerDependencies {
  db: Db;
  vault: KeyVault;
  createLanguageModel: (provider: ProviderId, modelId: string, apiKey: string) => LanguageModelV4;
  /** The time limits for a purpose (default: CALL_LIMITS); tests pass small ones. */
  limitsFor?: (purpose: string) => CallLimits;
  /** The wait before the first retry, doubled for each one after (default 1 s). */
  retryDelayMs?: number;
  /** The commit the app was deployed from, recorded with every call (`usage_events.release`). */
  release?: string;
}

/** What session jobs need from model access; tests substitute scripted models. */
export interface ModelAccess {
  model(request: ModelRequest): Promise<LanguageModelV4>;
  /** The learner's provider's web search tool, if it has one. */
  searchTool(userId: string): Promise<Tool | undefined>;
}

export interface ModelRequest {
  userId: string;
  /**
   * What the call is for, recorded with its usage and choosing its time limits and reasoning effort:
   * "probe", "probe-decision", "lesson", "check", "term-sweep", "aside"…
   */
  purpose: string;
  /** strong: the learner's chosen model · cheap: the provider's cheap model (asides, small jobs). */
  role: "strong" | "cheap";
  /** The track the call is about, if any: a track's calls share a provider cache (call-options.ts). */
  trackId?: string;
  /** The session the call is made in, if any: its usage is shown per session. */
  sessionId?: string;
  /** The version of method.md the call is made under (`Method.version`), recorded with its usage. */
  methodVersion?: string;
}

/** One attempt at a call: what it was sent, what it answered (so far), and the run it is traced in. */
interface Exchange {
  params: LanguageModelV4CallOptions;
  reply?: () => Reply;
  trace: Trace | undefined;
}

/** Whether a failed insert named a row that is gone (a track deleted while its call ran). */
const isForeignKeyViolation = (error: unknown): boolean => {
  for (let e = error, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++)
    if ("code" in e && e.code === "23503") return true;
  return false;
};

/**
 * Hands out language models built with the learner's key, decrypted for this call only. Every call
 * made through them records its usage and is stored in full (`model_calls`), failed calls included,
 * runs within its purpose's time limits and is shaped for the provider (cache hints;
 * call-options.ts), because all of it lives in middleware around the model rather than in each
 * caller.
 */
export function createModelCaller(deps: ModelCallerDependencies): ModelAccess {
  const { db, vault, limitsFor = callLimitsFor, retryDelayMs = 1000, release } = deps;

  return {
    async searchTool(userId) {
      const [credential] = await db
        .select()
        .from(credentials)
        .where(eq(credentials.userId, userId));
      if (!credential) throw new NoCredentialError();
      return createSearchTool(credential.provider, vault.open(credential.sealedKey, userId));
    },
    async model(request: ModelRequest): Promise<LanguageModelV4> {
      const [credential] = await db
        .select()
        .from(credentials)
        .where(eq(credentials.userId, request.userId));
      if (!credential) throw new NoCredentialError();
      const { provider } = credential;
      const modelId =
        request.role === "cheap"
          ? (cheapModelFor(provider)?.id ?? credential.model)
          : credential.model;
      const apiKey = vault.open(credential.sealedKey, request.userId);
      const limits = limitsFor(request.purpose);

      /**
       * Stores what an attempt was sent and answered (design §4.4), and hands the run it is traced
       * in the way to record its verdict (call-trace.ts). Best-effort: the call's work doesn't
       * depend on it, so a failure is logged, not thrown. A call whose track or session was deleted
       * while it ran has nothing left to be stored with, like the rest of its track's content.
       */
      const store = async (
        usageEventId: string,
        exchange: Exchange,
        reply: Reply | undefined,
        error: unknown,
      ) => {
        try {
          await db.insert(modelCalls).values({
            usageEventId,
            trackId: request.trackId ?? null,
            sessionId: request.sessionId ?? null,
            ...storedRequest(exchange.params),
            reply: reply ? storedReply(reply) : null,
            error: error === undefined ? null : storedError(error),
          });
        } catch (failure) {
          if (isForeignKeyViolation(failure))
            log.info("the call's track or session was deleted; its content is not stored");
          else log.error({ err: failure }, "a model call's content could not be stored");
          return;
        }
        if (error !== undefined || !exchange.trace) return;
        // A second verdict on the call (its track edits, beside its reply) adds its issues.
        exchange.trace.calls.push(async (verdict) => {
          try {
            await db
              .update(modelCalls)
              .set({
                verdict: sql`case when ${modelCalls.verdict} is null then ${JSON.stringify(verdict)}::jsonb
                  else jsonb_set(${modelCalls.verdict}, '{issues}',
                    (${modelCalls.verdict} -> 'issues') || ${JSON.stringify(verdict.issues)}::jsonb) end`,
              })
              .where(eq(modelCalls.usageEventId, usageEventId));
          } catch (failure) {
            log.error({ err: failure }, "a model call's verdict could not be stored");
          }
        });
      };
      /**
       * Records and logs one attempt: its usage, how it ended and how long it took since startedAt,
       * and stores it in full. A failure's line has the cause (status and the provider's error
       * body, never the request). With LOG_CONTENT on, the line also has what the call asked and
       * what it answered (so far).
       */
      const record = async (
        usage: LanguageModelV4Usage | null,
        failure: { kind: ProviderErrorKind; error: unknown; elapsedMs: number } | null,
        startedAt: number,
        exchange: Exchange,
      ) => {
        const reply = exchange.reply?.();
        const durationMs = Date.now() - startedAt;
        const tokens = {
          inputTokens: usage?.inputTokens.total ?? 0,
          cachedInputTokens: usage?.inputTokens.cacheRead ?? 0,
          cacheWriteTokens: usage?.inputTokens.cacheWrite ?? 0,
          outputTokens: usage?.outputTokens.total ?? 0,
        };
        const line = {
          userId: request.userId,
          ...(request.trackId ? { trackId: request.trackId } : {}),
          purpose: request.purpose,
          role: request.role,
          provider,
          model: modelId,
          ...tokens,
          durationMs,
          ...content(() => ({
            ...describePrompt(exchange.params.prompt, exchange.params.responseFormat),
            ...(reply ? { reply: describeReply(reply.content) } : {}),
          })),
        };
        if (!failure) log.info(line, "model call");
        else
          log[failure.kind === "unknown" ? "error" : "warn"](
            { ...line, errorKind: failure.kind, elapsedMs: failure.elapsedMs, err: failure.error },
            "model call failed",
          );
        const [event] = await db
          .insert(usageEvents)
          .values({
            userId: request.userId,
            trackId: request.trackId ?? null,
            sessionId: request.sessionId ?? null,
            provider,
            model: modelId,
            purpose: request.purpose,
            ...tokens,
            status: failure ? "error" : "ok",
            errorKind: failure?.kind ?? null,
            durationMs,
            methodVersion: request.methodVersion ?? null,
            release: release ?? null,
          })
          .returning({ id: usageEvents.id });
        if (event) await store(event.id, exchange, reply, failure ? failure.error : undefined);
      };
      /** Logs and records a failed attempt; returns the error with the learner's plain message. */
      const failed = async (
        error: unknown,
        deadline: Deadline,
        startedAt: number,
        exchange: Exchange,
      ): Promise<ProviderCallError> => {
        const converted = providerErrorFrom(provider, error);
        const cause = RetryError.isInstance(error) ? error.lastError : error;
        await record(
          null,
          { kind: converted.kind, error: cause, elapsedMs: deadline.elapsedMs },
          startedAt,
          exchange,
        );
        return converted;
      };
      /**
       * Runs the call, retrying retryable failures here rather than in the SDK: a retry gets only the
       * time the call has left, and whatever fails reaches the job as a ProviderCallError (the SDK
       * would wrap it in a RetryError). A timeout is final, and the caller's own abort passes
       * through unchanged, unrecorded: it is not a provider failure. Returns the result with the start
       * of the attempt that produced it.
       */
      const attempt = async <T>(
        deadline: Deadline,
        exchange: Exchange,
        run: () => PromiseLike<T>,
      ): Promise<{ result: T; startedAt: number }> => {
        for (let retry = 0; ; retry++) {
          const startedAt = Date.now();
          try {
            return { result: await deadline.race(run()), startedAt };
          } catch (error) {
            deadline.unwatch();
            if (deadline.callerAborted()) throw error;
            const converted = await failed(error, deadline, startedAt, exchange);
            const delay = retryDelayMs * 2 ** retry;
            const retryable = APICallError.isInstance(error) && error.isRetryable;
            if (!retryable || retry >= CALL_RETRIES || deadline.remainingMs <= delay)
              throw converted;
            try {
              await deadline.sleep(delay);
            } catch (aborted) {
              if (deadline.callerAborted()) throw aborted;
              throw converted;
            }
          }
        }
      };

      return wrapLanguageModel({
        model: deps.createLanguageModel(provider, modelId, apiKey),
        middleware: {
          specificationVersion: "v4",
          transformParams: ({ params }) =>
            Promise.resolve(
              shapeCall(
                { provider, modelId, purpose: request.purpose, trackId: request.trackId },
                params,
              ),
            ),
          wrapGenerate: async ({ model, params }) => {
            const deadline = new Deadline(params.abortSignal, limits.generateMs);
            const trace = currentTrace();
            try {
              const { result, startedAt } = await attempt(deadline, { params, trace }, () =>
                model.doGenerate({ ...params, abortSignal: deadline.signal }),
              );
              await record(result.usage, null, startedAt, {
                params,
                trace,
                reply: () => ({
                  content: result.content,
                  finishReason: result.finishReason,
                  ...(result.providerMetadata ? { providerMetadata: result.providerMetadata } : {}),
                }),
              });
              return result;
            } finally {
              deadline.dispose();
            }
          },
          wrapStream: async ({ model, params }) => {
            const deadline = new Deadline(params.abortSignal, limits.streamMs);
            // Taken here: the stream's parts are pulled later, by whatever reads them.
            const trace = currentTrace();
            let connected;
            try {
              connected = await attempt(deadline, { params, trace }, () => {
                deadline.watch(limits.thinkMs);
                return model.doStream({ ...params, abortSignal: deadline.signal });
              });
            } catch (error) {
              deadline.dispose();
              throw error;
            }
            const { result, startedAt } = connected;
            const reader = result.stream.getReader();
            // The connection's watch carries on until the first part: it has thinkMs in all.
            let silence: number | undefined;
            let recorded = false;
            const reply = new ReplyCollector();
            const exchange: Exchange = { params, trace, reply: () => reply.reply() };
            const finish = async (usage: LanguageModelV4Usage) => {
              if (recorded) return;
              recorded = true;
              await record(usage, null, startedAt, exchange);
            };
            const fail = async (error: unknown) => {
              if (recorded) return providerErrorFrom(provider, error);
              recorded = true;
              return failed(error, deadline, startedAt, exchange);
            };
            // Pulled, so the watch covers only the wait for the model, never a slow reader.
            const stream = new ReadableStream<LanguageModelV4StreamPart>({
              async pull(controller) {
                let next;
                try {
                  if (silence !== undefined) deadline.watch(silence);
                  next = await deadline.race(reader.read());
                  deadline.unwatch();
                } catch (error) {
                  deadline.dispose();
                  reader.cancel(error).catch(() => undefined);
                  if (deadline.callerAborted()) {
                    controller.error(error);
                    return;
                  }
                  controller.enqueue({ type: "error", error: await fail(error) });
                  controller.close();
                  return;
                }
                if (next.done) {
                  deadline.dispose();
                  controller.close();
                  return;
                }
                const part = next.value;
                silence = silenceAfter(part, limits);
                reply.add(part);
                if (part.type === "finish") await finish(part.usage);
                if (part.type === "error") {
                  controller.enqueue({ type: "error", error: await fail(part.error) });
                  return;
                }
                controller.enqueue(part);
              },
              async cancel(reason) {
                deadline.dispose();
                await reader.cancel(reason);
              },
            });
            return { ...result, stream };
          },
        },
      });
    },
  };
}
