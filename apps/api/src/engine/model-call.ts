import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import type { KeyVault } from "@grounded/crypto";
import { credentials, eq, usageEvents, type Db } from "@grounded/db";
import {
  cheapModelFor,
  classifyProviderError,
  createSearchTool,
  type ProviderErrorKind,
  type ProviderId,
} from "@grounded/providers";
import { APICallError, RetryError, wrapLanguageModel, type Tool } from "ai";
import {
  CALL_RETRIES,
  callLimitsFor,
  Deadline,
  silenceAfter,
  type CallLimits,
} from "./call-limits.js";
import { shapeCall } from "./call-options.js";

/** A provider failure with the plain message the learner is shown (design §4.4). */
export class ProviderCallError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ProviderCallError";
  }
}

export class NoCredentialError extends Error {
  constructor() {
    super("Add your AI key in Settings first.");
    this.name = "NoCredentialError";
  }
}

/** Turns any failure of a model call into a ProviderCallError, unwrapping the SDK's retry wrapper. */
export function providerErrorFrom(provider: ProviderId, error: unknown): ProviderCallError {
  if (error instanceof ProviderCallError) return error;
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  const { kind, message } = classifyProviderError(provider, cause);
  return new ProviderCallError(kind, message);
}

export interface ModelCallerDependencies {
  db: Db;
  vault: KeyVault;
  createLanguageModel: (provider: ProviderId, modelId: string, apiKey: string) => LanguageModelV4;
  /** The time limits for a purpose (default: CALL_LIMITS); tests pass small ones. */
  limitsFor?: (purpose: string) => CallLimits;
  /** The wait before the first retry, doubled for each one after (default 1 s). */
  retryDelayMs?: number;
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
}

/**
 * Hands out language models built with the learner's key, decrypted for this call only. Every call
 * made through them records its usage, failed calls included, runs within its purpose's time limits
 * and is shaped for the provider (cache hints; call-options.ts), because all three live in
 * middleware around the model rather than in each caller.
 */
export function createModelCaller(deps: ModelCallerDependencies): ModelAccess {
  const { db, vault, limitsFor = callLimitsFor, retryDelayMs = 1000 } = deps;

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

      const record = async (
        usage: LanguageModelV4Usage | null,
        errorKind: ProviderErrorKind | null,
      ) => {
        await db.insert(usageEvents).values({
          userId: request.userId,
          provider,
          model: modelId,
          purpose: request.purpose,
          inputTokens: usage?.inputTokens.total ?? 0,
          cachedInputTokens: usage?.inputTokens.cacheRead ?? 0,
          outputTokens: usage?.outputTokens.total ?? 0,
          status: errorKind ? "error" : "ok",
          errorKind,
        });
      };
      /** Logs and records a failed attempt; returns the error with the learner's plain message. */
      const failed = async (error: unknown, deadline: Deadline): Promise<ProviderCallError> => {
        const converted = providerErrorFrom(provider, error);
        // The learner sees a plain message; the operator needs the cause (never the learner's text).
        console.error(
          `model call failed: ${provider}/${modelId} (${request.purpose}) after ${(deadline.elapsedMs / 1000).toFixed(1)} s → ${converted.kind}: ${describeFailure(error)}`,
        );
        await record(null, converted.kind);
        return converted;
      };
      /**
       * Runs the call, retrying retryable failures here rather than in the SDK: a retry gets only the
       * time the call has left, and whatever fails reaches the job as a ProviderCallError (the SDK
       * would wrap it in a RetryError). A timeout is final, and the caller's own abort passes
       * through unchanged, unrecorded: it is not a provider failure.
       */
      const attempt = async <T>(deadline: Deadline, run: () => PromiseLike<T>): Promise<T> => {
        for (let retry = 0; ; retry++) {
          try {
            return await deadline.race(run());
          } catch (error) {
            deadline.unwatch();
            if (deadline.callerAborted()) throw error;
            const converted = await failed(error, deadline);
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
              shapeCall({ provider, purpose: request.purpose, trackId: request.trackId }, params),
            ),
          wrapGenerate: async ({ model, params }) => {
            const deadline = new Deadline(params.abortSignal, limits.generateMs);
            try {
              const result = await attempt(deadline, () =>
                model.doGenerate({ ...params, abortSignal: deadline.signal }),
              );
              await record(result.usage, null);
              return result;
            } finally {
              deadline.dispose();
            }
          },
          wrapStream: async ({ model, params }) => {
            const deadline = new Deadline(params.abortSignal, limits.streamMs);
            let result;
            try {
              result = await attempt(deadline, () => {
                deadline.watch(limits.thinkMs);
                return model.doStream({ ...params, abortSignal: deadline.signal });
              });
            } catch (error) {
              deadline.dispose();
              throw error;
            }
            const reader = result.stream.getReader();
            // The connection's watch carries on until the first part: it has thinkMs in all.
            let silence: number | undefined;
            let recorded = false;
            const finish = async (usage: LanguageModelV4Usage) => {
              if (recorded) return;
              recorded = true;
              await record(usage, null);
            };
            const fail = async (error: unknown) => {
              if (recorded) return providerErrorFrom(provider, error);
              recorded = true;
              return failed(error, deadline);
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

/** Status and the provider's error body, for the operator's log. */
function describeFailure(error: unknown): string {
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  if (APICallError.isInstance(cause)) {
    return `${String(cause.statusCode ?? "no status")} ${(cause.responseBody ?? cause.message).slice(0, 500)}`;
  }
  return cause instanceof Error ? cause.message : String(cause);
}
