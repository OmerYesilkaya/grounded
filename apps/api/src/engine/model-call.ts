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
}

/** What session jobs need from model access; tests substitute scripted models. */
export interface ModelAccess {
  model(request: ModelRequest): Promise<LanguageModelV4>;
  /** The learner's provider's web search tool, if it has one. */
  searchTool(userId: string): Promise<Tool | undefined>;
}

export interface ModelRequest {
  userId: string;
  /** What the call is for, recorded with its usage: "probe", "lesson", "check", "aside"… */
  purpose: string;
  /** strong: the learner's chosen model · cheap: the provider's cheap model (asides, small jobs). */
  role: "strong" | "cheap";
}

/**
 * Hands out language models built with the learner's key, decrypted for this call only. Every call
 * made through them records its usage, failed calls included, because the recording lives in
 * middleware around the model rather than in each caller.
 */
export function createModelCaller(deps: ModelCallerDependencies): ModelAccess {
  const { db, vault } = deps;

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
      // Retryable failures go back to the SDK unchanged so it can retry; each attempt is recorded.
      const fail = async (error: unknown): Promise<never> => {
        const converted = providerErrorFrom(provider, error);
        // The learner sees a plain message; the operator needs the cause (never the learner's text).
        console.error(
          `model call failed: ${provider}/${modelId} (${request.purpose}) → ${converted.kind}: ${describeFailure(error)}`,
        );
        await record(null, converted.kind);
        if (APICallError.isInstance(error) && error.isRetryable) throw error;
        throw converted;
      };

      return wrapLanguageModel({
        model: deps.createLanguageModel(provider, modelId, apiKey),
        middleware: {
          specificationVersion: "v4",
          wrapGenerate: async ({ doGenerate }) => {
            try {
              const result = await doGenerate();
              await record(result.usage, null);
              return result;
            } catch (error) {
              return fail(error);
            }
          },
          wrapStream: async ({ doStream }) => {
            let result;
            try {
              result = await doStream();
            } catch (error) {
              return fail(error);
            }
            let recorded = false;
            const recordOnce = async (usage: LanguageModelV4Usage | null, error: unknown) => {
              if (recorded) return;
              recorded = true;
              await record(
                usage,
                error === undefined ? null : providerErrorFrom(provider, error).kind,
              );
            };
            const watch = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>(
              {
                async transform(part, controller) {
                  if (part.type === "finish") await recordOnce(part.usage, undefined);
                  if (part.type === "error") await recordOnce(null, part.error);
                  controller.enqueue(part);
                },
              },
            );
            return { ...result, stream: result.stream.pipeThrough(watch) };
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
