import { AsyncLocalStorage } from "node:async_hooks";
import {
  APICallError,
  InvalidResponseDataError,
  JSONParseError,
  TypeValidationError,
} from "@ai-sdk/provider";
import { RetryError } from "ai";
import pino, { type DestinationStream, type Logger } from "pino";
import PinoPretty from "pino-pretty";

/*
 * One structured logger for the API, the worker and the engine (design §4.2, "Logs"): JSON lines in
 * production, one readable line per entry otherwise, at LOG_LEVEL (default info; silent in tests).
 *
 * Every line carries the fields of the context it was written in: a request's `requestId` (and the
 * `userId`, `sessionId`, `trackId` it touches), a job's `jobId`, `task` and `sessionId`, and the
 * `requestId` of the request that queued it. Code adds what it learns with addLogContext; nothing
 * is passed around.
 *
 * Never log a key (plain or sealed), a session cookie, or anything a learner
 * or the tutor wrote: ids, counts, codes and the app's own messages only. Errors are logged through
 * serializeError, which keeps the fields that diagnose a failure and none that carry content.
 *
 * The one exception is LOG_CONTENT=true, an operator's switch for diagnosing what a model was asked
 * and answered: lines then also carry the fields passed through `content()`, under `content`, and
 * errors keep the messages that quote content. Off, `content()` adds nothing.
 */

export type { Logger };

export type LogFields = Record<string, unknown>;

const context = new AsyncLocalStorage<LogFields>();

/** Runs `run` with these fields added to every line it logs (on top of the current context's). */
export function withLogContext<T>(fields: LogFields, run: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, run);
}

/** Adds fields to the current context (a request's, a job's), from here to its end. */
export function addLogContext(fields: LogFields): void {
  const store = context.getStore();
  if (store) Object.assign(store, fields);
}

/** The current context's fields. */
export function logContext(): Readonly<LogFields> {
  return context.getStore() ?? {};
}

const LEVELS = ["silent", "fatal", "error", "warn", "info", "debug", "trace"] as const;

function levelFrom(env: NodeJS.ProcessEnv): string {
  const level = env.LOG_LEVEL?.trim().toLowerCase();
  if (!level) return env.NODE_ENV === "test" ? "silent" : "info";
  if (!(LEVELS as readonly string[]).includes(level))
    throw new Error(`Invalid LOG_LEVEL "${level}": use one of ${LEVELS.join(", ")}.`);
  return level;
}

function contentFrom(env: NodeJS.ProcessEnv): boolean {
  const value = env.LOG_CONTENT?.trim().toLowerCase();
  if (!value || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`Invalid LOG_CONTENT "${value}": use true or false.`);
}

let contentLogging = contentFrom(process.env);

/** Whether lines carry content (LOG_CONTENT). */
export const logsContent = (): boolean => contentLogging;

/**
 * Content for a line, under `content`, when LOG_CONTENT is on; nothing otherwise. Pass a function
 * when the content is costly to build: it runs only when it is logged.
 */
export function content(fields: LogFields | (() => LogFields)): LogFields {
  if (!contentLogging) return {};
  return { content: typeof fields === "function" ? fields() : fields };
}

const production = process.env.NODE_ENV === "production";

/** A line's message is `message`, the field log hosts (Railway among them) read it from. */
const MESSAGE_KEY = "message";

/** Where lines go: stdout, as JSON in production and pretty otherwise. Tests swap it (captureLogs). */
let destination: DestinationStream = production
  ? pino.destination({ dest: 1, sync: true })
  : PinoPretty({
      sync: true,
      singleLine: true,
      colorize: process.stdout.isTTY,
      translateTime: "SYS:HH:MM:ss.l",
      messageKey: MESSAGE_KEY,
      ignore: "pid,hostname",
    });

export const log: Logger = pino(
  {
    level: levelFrom(process.env),
    // A copy: pino merges the line's own fields into what the mixin returns.
    mixin: () => ({ ...context.getStore() }),
    serializers: { err: serializeError },
    // A second line of defence; the first is never passing these at all.
    redact: {
      paths: [
        "apiKey",
        "*.apiKey",
        "sealedKey",
        "*.sealedKey",
        "token",
        "*.token",
        "headers.authorization",
        "headers.cookie",
      ],
      censor: "[redacted]",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: MESSAGE_KEY,
    // Level names, not numbers: `jq 'select(.level == "error")'`.
    formatters: { level: (label: string) => ({ level: label }) },
  },
  {
    write: (line: string) => {
      destination.write(line);
    },
  },
);

/** Names the process in every line ("api", "worker"). */
export function setLogService(service: string): void {
  log.setBindings({ service });
}

/**
 * For tests: sends every line, as parsed JSON, to `lines` at `level` until restored. Lines are the
 * JSON production writes, whatever the environment; `withContent` turns LOG_CONTENT on meanwhile.
 */
export function captureLogs(level = "trace", options: { withContent?: boolean } = {}) {
  const lines: LogFields[] = [];
  const text: string[] = [];
  const previous = { destination, level: log.level, contentLogging };
  contentLogging = options.withContent ?? false;
  destination = {
    write(line: string) {
      text.push(line);
      lines.push(JSON.parse(line) as LogFields);
    },
  };
  log.level = level;
  return {
    lines,
    /** Everything written, exactly as written. */
    text: () => text.join(""),
    restore: () => {
      destination = previous.destination;
      log.level = previous.level;
      contentLogging = previous.contentLogging;
    },
  };
}

export interface SerializedError {
  type: string;
  message: string;
  stack?: string;
  /** A ProviderCallError's kind. */
  kind?: string;
  /** A Postgres or Node error code. */
  code?: string;
  /** An HTTP call's status and the provider's error body (never the request, which holds the prompt). */
  status?: number;
  body?: string;
  cause?: SerializedError;
}

/** Errors whose message quotes the content they failed on (the model's output). */
const QUOTES_CONTENT = [TypeValidationError, JSONParseError, InvalidResponseDataError];

const quotesContent = (error: Error) =>
  QUOTES_CONTENT.some((kind) => kind.isInstance(error)) ||
  // JSON.parse quotes the start of what it couldn't parse.
  (error instanceof SyntaxError && error.message.includes("JSON"));

/**
 * An error for the log: its type, message, stack frames, status and body, and its cause chain. No
 * other property is copied: an SDK error carries the request (the prompt, so the learner's words)
 * and sometimes the model's output. A message that quotes content is withheld.
 */
export function serializeError(error: unknown, depth = 0): SerializedError {
  if (!(error instanceof Error)) return { type: typeof error, message: clip(String(error), 200) };
  const serialized: SerializedError = {
    type: error.name,
    message:
      quotesContent(error) && !contentLogging
        ? "(withheld: it quotes content)"
        : clip(error.message, contentLogging ? 20_000 : 1000),
  };
  // Frames only: the stack's first lines repeat the message.
  const frames = error.stack
    ?.split("\n")
    .filter((line) => /^\s+at /.test(line))
    .join("\n");
  if (frames) serialized.stack = frames;
  if ("kind" in error && typeof error.kind === "string") serialized.kind = error.kind;
  if ("code" in error && typeof error.code === "string") serialized.code = error.code;
  if (APICallError.isInstance(error)) {
    if (error.statusCode !== undefined) serialized.status = error.statusCode;
    if (error.responseBody) serialized.body = clip(error.responseBody, 500);
  }
  const cause = RetryError.isInstance(error) ? error.lastError : error.cause;
  if (cause !== undefined && depth < 5) serialized.cause = serializeError(cause, depth + 1);
  return serialized;
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}… (${String(text.length)} characters)` : text;
