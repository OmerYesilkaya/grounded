import {
  Logger,
  makeWorkerUtils,
  run,
  runMigrations,
  type TaskList,
  type WorkerUtils,
} from "graphile-worker";
import { AsyncLocalStorage } from "node:async_hooks";
import { log, logContext, withLogContext, type LogFields } from "../log.js";
import { createWorkLocks, holdingWorkLocks } from "./work-locks.js";

export interface JobQueue {
  /** Queues a job; it carries the current request id, so its lines can be traced to the request. */
  enqueue(task: string, payload: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

const GRAPHILE_LEVELS = { error: "error", warning: "warn", info: "debug", debug: "trace" } as const;

/**
 * graphile-worker's own lines, through the app's logger: its warnings and errors as such, its
 * chatter at debug. Its line for each job's end is left out: the job's own lines say it, without
 * quoting the error's message (loggingJobs).
 */
const graphileLogger = new Logger((scope) => (level, message, meta) => {
  if (meta.failure === true || meta.success === true) return;
  const fields: LogFields = { source: "graphile-worker" };
  if (scope.workerId) fields.workerId = scope.workerId;
  if (scope.taskIdentifier) fields.task = scope.taskIdentifier;
  if (scope.jobId) fields.jobId = scope.jobId;
  if (meta.error !== undefined) fields.err = meta.error;
  log[GRAPHILE_LEVELS[level]](fields, message);
});

/**
 * Jobs live in Postgres (graphile-worker), which wakes workers through LISTEN/NOTIFY, so a chat
 * reply starts at once. A job is attempted once: the SDK already retries provider calls, and a blind
 * retry could spend the learner's credit twice.
 */
export function createJobQueue(connectionString: string): JobQueue {
  let utils: Promise<WorkerUtils> | null = null;
  const ready = () =>
    (utils ??= makeWorkerUtils({ connectionString, logger: graphileLogger }).then(async (u) => {
      await u.migrate();
      return u;
    }));
  return {
    async enqueue(task, payload) {
      const { requestId } = logContext();
      const job = await (
        await ready()
      ).addJob(task, requestId ? { ...payload, requestId } : payload, { maxAttempts: 1 });
      log.debug({ queuedJobId: job.id, queuedTask: task }, "job queued");
    },
    async close() {
      if (utils) await (await utils).release();
    },
  };
}

export interface Worker {
  stop(): Promise<void>;
}

/**
 * Runs the tasks until stopped. Each job holds its session's work lock while it runs (work-locks.ts);
 * `onLocksLost` is called if the process loses them.
 */
export async function startWorker(
  connectionString: string,
  tasks: TaskList,
  options: { concurrency: number; onLocksLost?: () => void },
): Promise<Worker> {
  const locks = createWorkLocks(connectionString, options.onLocksLost ?? (() => undefined));
  const runner = await run({
    connectionString,
    taskList: loggingJobs(holdingWorkLocks(tasks, locks)),
    concurrency: options.concurrency,
    noHandleSignals: true,
    logger: graphileLogger,
  });
  return {
    async stop() {
      await runner.stop();
      await locks.close();
    },
  };
}

/** Creates or updates graphile-worker's schema, which recovery reads before the worker starts. */
export async function migrateQueue(connectionString: string): Promise<void> {
  await runMigrations({ connectionString, logger: graphileLogger });
}

const jobOutcome = new AsyncLocalStorage<{ handled?: unknown }>();

/**
 * Tells the job's log that it failed although it ends without an error: the failure was handled
 * (the learner was told), so graphile-worker counts the job done.
 */
export function reportHandledFailure(error: unknown): void {
  const outcome = jobOutcome.getStore();
  if (outcome) outcome.handled = error;
}

/**
 * Wraps each task so that every job logs its start and its end (finished or failed, with the
 * error's cause chain, and how long it took), in a log context of its own: the job id, the task,
 * the payload's session and step, and the id of the request that queued it.
 */
export function loggingJobs(tasks: TaskList): TaskList {
  const wrapped: TaskList = {};
  for (const [name, task] of Object.entries(tasks)) {
    if (!task) continue;
    wrapped[name] = (payload, helpers) =>
      withLogContext({ jobId: helpers.job.id, task: name, ...idsIn(payload) }, () =>
        jobOutcome.run({}, async () => {
          const startedAt = performance.now();
          const durationMs = () => Math.round(performance.now() - startedAt);
          log.info({ waitedMs: Date.now() - helpers.job.run_at.getTime() }, "job started");
          try {
            await task(payload, helpers);
          } catch (error) {
            log.error({ err: error, durationMs: durationMs() }, "job failed");
            throw error;
          }
          const { handled } = jobOutcome.getStore() ?? {};
          if (handled === undefined) log.info({ durationMs: durationMs() }, "job finished");
          else log.warn({ err: handled, durationMs: durationMs(), handled: true }, "job failed");
        }),
      );
  }
  return wrapped;
}

/** The ids a job's payload carries, for its log context. */
function idsIn(payload: unknown): LogFields {
  if (typeof payload !== "object" || payload === null) return {};
  const ids: LogFields = {};
  for (const key of ["sessionId", "stepId", "requestId"])
    if (key in payload) ids[key] = (payload as Record<string, unknown>)[key];
  return ids;
}
