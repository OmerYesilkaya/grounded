import {
  Logger,
  makeWorkerUtils,
  run,
  type Runner,
  type TaskList,
  type WorkerUtils,
} from "graphile-worker";

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

export function startWorker(
  connectionString: string,
  tasks: TaskList,
  options: { concurrency: number },
): Promise<Runner> {
  return run({
    connectionString,
    taskList: tasks,
    concurrency: options.concurrency,
    noHandleSignals: true,
    logger: quiet,
  });
}
