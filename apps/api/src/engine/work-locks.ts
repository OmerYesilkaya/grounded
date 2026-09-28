import { sql, type Db } from "@grounded/db";
import type { TaskList } from "graphile-worker";
import postgres from "postgres";
import { log } from "../log.js";

/*
 * Which sessions a live job is working on. graphile-worker can't say: a job whose worker died stays
 * locked, with nothing to tell it from a running one, until its four-hour lock timeout. So every job
 * holds its session's work lock while it runs: a shared Postgres advisory lock (several jobs may work
 * on one session at once) on a connection its worker process keeps open for its whole life. Postgres
 * drops a connection's locks when the connection ends, so a lock is held exactly as long as a job
 * that took it is running in a live process; a killed worker's locks go with it.
 *
 * Recovery (recovery.ts) takes the same lock exclusively for the length of its transaction: if it
 * can, no live job is working on the session, and none can start on it until recovery is done, so
 * anything a job left half-done there belongs to a job that is gone.
 */

/** The advisory lock class of session work locks; the second key is the session id's hash. */
const WORK_LOCK = 1_735_552_612;

export interface WorkLocks {
  /** Runs the work holding the session's work lock. */
  holding<T>(sessionId: string, run: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * The worker process's work locks, on a connection of their own that is never recycled. If it is
 * lost anyway, so are the locks, and `onLost` is called: the process's jobs are no longer protected.
 */
export function createWorkLocks(connectionString: string, onLost: () => void): WorkLocks {
  let closing = false;
  const client = postgres(connectionString, {
    max: 1,
    max_lifetime: null,
    onclose: () => {
      if (closing) return;
      log.error("the connection holding this worker's work locks closed");
      onLost();
    },
  });
  return {
    async holding(sessionId, run) {
      await client`select pg_advisory_lock_shared(${WORK_LOCK}::int, hashtext(${sessionId}::text))`;
      try {
        return await run();
      } finally {
        // A lost connection has released the lock already (and onLost was told).
        await client`select pg_advisory_unlock_shared(${WORK_LOCK}::int, hashtext(${sessionId}::text))`.catch(
          () => undefined,
        );
      }
    },
    async close() {
      closing = true;
      await client.end();
    },
  };
}

/** Wraps each task so that a job holds its session's work lock while it runs. */
export function holdingWorkLocks(tasks: TaskList, locks: WorkLocks): TaskList {
  const wrapped: TaskList = {};
  for (const [name, task] of Object.entries(tasks)) {
    if (!task) continue;
    wrapped[name] = (payload: unknown, helpers) => {
      const sessionId = sessionIdOf(payload);
      return sessionId
        ? locks.holding(sessionId, async () => task(payload, helpers))
        : task(payload, helpers);
    };
  }
  return wrapped;
}

function sessionIdOf(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  return "sessionId" in payload && typeof payload.sessionId === "string"
    ? payload.sessionId
    : undefined;
}

/**
 * Runs the work unless a live job is working on the session (then returns null). No job can start
 * on the session until the work is done.
 */
export async function unlessWorkedOn<T>(
  db: Db,
  sessionId: string,
  run: () => Promise<T>,
): Promise<T | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx.execute(
      sql`select pg_try_advisory_xact_lock(${WORK_LOCK}::int, hashtext(${sessionId}::text)) as free`,
    );
    return row?.free === true ? run() : null;
  });
}
