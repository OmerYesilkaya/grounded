import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";

/** How long a model call may take before the learner is told to try again (issue #12). */
export interface CallLimits {
  /** A non-streamed call (structured decisions, grading, rewrites), its retries included. */
  generateMs: number;
  /** A streamed call from start to its last part, retries of the connection included. */
  streamMs: number;
  /**
   * Streamed: silence allowed before the first part and between one output and the next, where the
   * model may be reasoning or running a web search without sending anything.
   */
  thinkMs: number;
  /** Streamed: silence allowed in the middle of an output, between one delta and the next. */
  idleMs: number;
}

const SECOND = 1000;

/**
 * The limits per purpose (ModelRequest.purpose); purposes not listed use `default`. A healthy call
 * finishes well inside them: they exist to end a hung connection, not to cut a slow model short.
 * - default: chat messages (probe, close, aside, homework) stream a few hundred words, and the
 *   structured decisions and grading after them are small JSON; 90 s is several times a normal call.
 * - plan: the plan's term-and-arc record is the largest structured output outside the lesson.
 * - review: a handed-in assignment's review (design §7.4) reads the whole answer, pictures too,
 *   and returns its comments, the checklist's marks and the term changes in one structured output,
 *   thinking at the default effort first.
 * - lesson: the outline is a large structured output, a step rewrite is a full step of markdown,
 *   and the whole lesson is written in one stream that can run for minutes; the model also plans
 *   the lesson before its first word. The idle limit stays short: a stream that has started
 *   writing and then goes quiet is stuck.
 * - source-transcribe, source-summary: reading a source (design §4.6): a batch of pages copied out
 *   in full, or the summaries of sections tens of thousands of characters long, in one output.
 */
export const CALL_LIMITS = {
  default: {
    generateMs: 90 * SECOND,
    streamMs: 180 * SECOND,
    thinkMs: 60 * SECOND,
    idleMs: 30 * SECOND,
  },
  plan: {
    generateMs: 120 * SECOND,
    streamMs: 180 * SECOND,
    thinkMs: 60 * SECOND,
    idleMs: 30 * SECOND,
  },
  review: {
    generateMs: 180 * SECOND,
    streamMs: 180 * SECOND,
    thinkMs: 60 * SECOND,
    idleMs: 30 * SECOND,
  },
  lesson: {
    generateMs: 180 * SECOND,
    streamMs: 600 * SECOND,
    thinkMs: 90 * SECOND,
    idleMs: 30 * SECOND,
  },
} as const satisfies Record<string, CallLimits>;

export function callLimitsFor(purpose: string): CallLimits {
  if (purpose === "source-transcribe" || purpose === "source-summary") return CALL_LIMITS.review;
  return purpose === "plan" || purpose === "lesson" || purpose === "review"
    ? CALL_LIMITS[purpose]
    : CALL_LIMITS.default;
}

/** Retries of a retryable failure (network, 5xx, 429), each only if the call's time allows. */
export const CALL_RETRIES = 2;

/** Parts in the middle of an output: after one, the next follows quickly unless the stream is stuck. */
const DELTAS = new Set<LanguageModelV4StreamPart["type"]>([
  "text-delta",
  "reasoning-delta",
  "tool-input-delta",
]);

/** The silence allowed after this part, before the next one must arrive. */
export function silenceAfter(part: LanguageModelV4StreamPart, limits: CallLimits): number {
  return DELTAS.has(part.type) ? limits.idleMs : limits.thinkMs;
}

/**
 * An abort signal for one model call that fires when the caller aborts, the call's total time runs
 * out, or a watch (a shorter limit on the current wait) expires, whichever comes first. Every timer
 * is cleared by dispose().
 */
export class Deadline {
  private readonly controller = new AbortController();
  private readonly startedAt = Date.now();
  private readonly totalTimer: ReturnType<typeof setTimeout>;
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private expired = false;
  private readonly onCallerAbort = () => {
    this.controller.abort(this.caller?.reason);
  };

  constructor(
    private readonly caller: AbortSignal | undefined,
    private readonly totalMs: number,
  ) {
    if (caller?.aborted) this.controller.abort(caller.reason);
    else caller?.addEventListener("abort", this.onCallerAbort, { once: true });
    this.totalTimer = setTimeout(() => {
      this.expire(`the call took longer than ${String(totalMs)} ms`);
    }, totalMs);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Whether the caller aborted the call before it ran out of time. */
  callerAborted(): boolean {
    return !this.expired && this.caller?.aborted === true;
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  get remainingMs(): number {
    return this.totalMs - this.elapsedMs;
  }

  /** Limits the current wait to `ms`, replacing any earlier watch. */
  watch(ms: number): void {
    this.unwatch();
    this.watchTimer = setTimeout(() => {
      this.expire(`nothing arrived for ${String(ms)} ms`);
    }, ms);
  }

  unwatch(): void {
    clearTimeout(this.watchTimer);
    this.watchTimer = undefined;
  }

  /**
   * Settles with the promise, or rejects with the abort reason as soon as the signal fires, even if
   * the model ignores its abort signal (a hung connection may never settle).
   */
  race<T>(promise: PromiseLike<T>): Promise<T> {
    const { signal } = this.controller;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        reject(signal.reason as Error);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(promise)
        .then(resolve, reject)
        .finally(() => {
          signal.removeEventListener("abort", onAbort);
        });
    });
  }

  /** Waits `ms`, unless the signal fires first. */
  async sleep(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.race(
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  dispose(): void {
    clearTimeout(this.totalTimer);
    this.unwatch();
    this.caller?.removeEventListener("abort", this.onCallerAbort);
  }

  private expire(reason: string): void {
    if (this.controller.signal.aborted) return;
    this.expired = true;
    // "TimeoutError" is what classifyProviderError reads as a timeout.
    this.controller.abort(new DOMException(reason, "TimeoutError"));
    this.dispose();
  }
}
