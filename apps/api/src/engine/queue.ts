import {
  Logger,
  makeWorkerUtils,
  run,
  runMigrations,
  type TaskList,
  type WorkerUtils,
} from "graphile-worker";
import { createWorkLocks, holdingWorkLocks } from "./work-locks.js";

export interface JobQueue {
  enqueue(task: string, payload: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

const quiet = new Logger(() => () => undefined);

/**
 * Jobs live in Postgres (graphile-worker), which wakes workers through LISTEN/NOTIFY, so a chat
 * reply starts at once. A job is attempted once: the SDK already retries provider calls, and a blind
 * retry could spend the learner's credit twice.
 */
export function createJobQueue(connectionString: string): JobQueue {
  let utils: Promise<WorkerUtils> | null = null;
  const ready = () =>
    (utils ??= makeWorkerUtils({ connectionString, logger: quiet }).then(async (u) => {
      await u.migrate();
      return u;
    }));
  return {
    async enqueue(task, payload) {
      await (await ready()).addJob(task, payload, { maxAttempts: 1 });
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
  const locks = createWorkLocks(
    connectionString,
    options.onLocksLost ??
      (() => {
        console.error("worker: lost the connection holding its work locks");
      }),
  );
  const runner = await run({
    connectionString,
    taskList: holdingWorkLocks(tasks, locks),
    concurrency: options.concurrency,
    noHandleSignals: true,
    logger: quiet,
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
  await runMigrations({ connectionString, logger: quiet });
}
