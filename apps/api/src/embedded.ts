import { randomBytes } from "node:crypto";
import { loadMethod, type Method } from "@grounded/core";
import { createKeyVault, type KeyVault } from "@grounded/crypto";
import { createDb, runMigrations, type Db } from "@grounded/db";
import type { KeyCheck, ProviderId } from "@grounded/providers";
import type { TaskList } from "graphile-worker";
import postgres from "postgres";
import { invite } from "./allowlist.js";
import { createApp } from "./app.js";
import { createEventHub } from "./engine/events.js";
import type { ModelAccess } from "./engine/model-call.js";
import { createJobQueue, startWorker, type JobQueue, type Worker } from "./engine/queue.js";
import { createTasks } from "./engine/tasks.js";
import { createMemoryFileStore } from "./files/store.js";
import type { VerifierOptions } from "./media/verify.js";
import { offlineWeb } from "./media/web.js";

/*
 * The whole backend in one process, for the test harness and the eval harness (tools/eval): the API
 * app answering requests in memory, and the worker running its jobs, on a database of their own.
 */

export const BASE_URL = "http://localhost:3000";

// What a harness around the embedded backend needs besides it.
export { invite } from "./allowlist.js";
export { createDemoModels } from "./dev/demo-models.js";
export { createModelCaller, type ModelAccess } from "./engine/model-call.js";
export { createWebAccess } from "./media/web.js";

/** A new, migrated database on the server `serverUrl` points at, named after it plus `suffix`. */
export async function createFreshDatabase(
  serverUrl: string,
  suffix: string,
): Promise<{ url: string; drop: () => Promise<void>; keep: () => Promise<void> }> {
  const url = new URL(serverUrl);
  url.pathname = `/${url.pathname.slice(1)}_${suffix}`;
  const name = url.pathname.slice(1);
  const admin = postgres({
    host: url.hostname,
    port: Number(url.port || 5432),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: "postgres",
    onnotice: () => undefined,
  });
  await admin.unsafe(`drop database if exists "${name}" with (force)`);
  await admin.unsafe(`create database "${name}"`);
  // Postgres's notices (a truncate's "truncate cascades to …") would print to stdout.
  await admin.unsafe(`alter database "${name}" set client_min_messages = warning`);
  await runMigrations(url.toString());
  return {
    url: url.toString(),
    drop: async () => {
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
      await admin.end();
    },
    /** Leaves the database in place, to be looked at. */
    keep: () => admin.end(),
  };
}

export interface EmbeddedOptions {
  databaseUrl: string;
  /**
   * Model access for the session jobs, or how to make it from the backend's database and vault (the
   * real model caller needs both); without it (and without `tasks`) no worker runs.
   */
  models?: ModelAccess | ((backend: { db: Db; vault: KeyVault }) => ModelAccess);
  /** Jobs to run besides (or instead of) the session jobs. */
  tasks?: TaskList;
  /** The teaching method (default: the repo's method.md). */
  method?: Method;
  /** Offer models the eval harness hasn't passed (default true, as in development). */
  includeUngatedModels?: boolean;
  /** How stored keys are checked (default: every key is fine). */
  validateKey?: (provider: ProviderId, apiKey: string) => Promise<KeyCheck>;
  workerConcurrency?: number;
  /** Where lesson media is found and verified (default: an offline web, so nothing verifies). */
  media?: VerifierOptions;
}

export interface Embedded {
  db: Db;
  vault: KeyVault;
  queue: JobQueue;
  /** Learners' files, in memory. */
  files: ReturnType<typeof createMemoryFileStore>;
  request: (path: string, init?: RequestInit & { cookie?: string }) => Response | Promise<Response>;
  /** Invites the email (minting its code) and signs it in as the sign-in page does; the cookie. */
  signIn: (email: string) => Promise<string>;
  /** Polls until the condition holds (for work done by the worker). */
  waitFor: (condition: () => Promise<boolean>, timeoutMs?: number) => Promise<void>;
  /** Starts the worker, if there are jobs to run and it isn't running yet. */
  startWorker: () => Promise<void>;
  /** Whether the worker has been running nothing for a moment. */
  workerIdle: () => Promise<boolean>;
  /** Lets running jobs finish, then stops the worker and closes every connection. */
  stop: () => Promise<void>;
}

export function createEmbedded(options: EmbeddedOptions): Embedded {
  const { databaseUrl } = options;
  const { db, client, close } = createDb(databaseUrl);
  const events = createEventHub(client);
  const queue = createJobQueue(databaseUrl);
  const vault = createKeyVault({ masterKeys: { e1: randomBytes(32) }, activeKid: "e1" });
  const files = createMemoryFileStore();
  let runner: Worker | undefined;

  const app = createApp({
    db,
    auth: { secret: "embedded-secret-that-is-long-enough-to-sign-with", secure: false },
    vault,
    events,
    queue,
    files,
    includeUngatedModels: options.includeUngatedModels ?? true,
    validateKey: options.validateKey ?? (() => Promise.resolve({ ok: true })),
  });

  const request = (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set("cookie", init.cookie);
    // A form sets its own content type, with the boundary.
    if (typeof init.body === "string") headers.set("content-type", "application/json");
    headers.set("origin", BASE_URL);
    return app.request(path.startsWith("http") ? path : `${BASE_URL}${path}`, { ...init, headers });
  };

  const signIn = async (email: string): Promise<string> => {
    const code = await invite(db, email);
    const response = await request("/api/auth/sign-in", {
      method: "POST",
      body: JSON.stringify({ email, code }),
    });
    if (!response.ok) throw new Error(`${email} could not sign in: ${await response.text()}`);
    return response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  };

  const waitFor = async (condition: () => Promise<boolean>, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  const workerIdle = async () => {
    if (runner?.running()) return false;
    await new Promise((r) => setTimeout(r, 50));
    return !runner?.running();
  };

  return {
    db,
    vault,
    queue,
    files,
    request,
    signIn,
    waitFor,
    workerIdle,
    startWorker: async () => {
      if (runner) return;
      const tasks = {
        ...(options.models
          ? createTasks({
              db,
              queue,
              files,
              method: options.method ?? loadMethod(),
              media: options.media ?? { web: offlineWeb },
              models:
                typeof options.models === "function"
                  ? options.models({ db, vault })
                  : options.models,
            })
          : {}),
        ...options.tasks,
      };
      if (Object.keys(tasks).length > 0)
        runner = await startWorker(databaseUrl, tasks, {
          concurrency: options.workerConcurrency ?? 2,
        });
    },
    stop: async () => {
      // Let running jobs finish: one stopped mid-run is left locked, its writes landing later.
      await waitFor(workerIdle, 9_000);
      await runner?.stop();
      await queue.close();
      await events.close();
      await close();
    },
  };
}
