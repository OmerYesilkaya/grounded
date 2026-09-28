import { randomBytes } from "node:crypto";
import { loadMethod } from "@grounded/core";
import { createKeyVault } from "@grounded/crypto";
import { createDb } from "@grounded/db";
import type { KeyCheck } from "@grounded/providers";
import type { TaskList } from "graphile-worker";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { createApp } from "../app.js";
import { createAuth } from "../auth.js";
import { createEventHub } from "../engine/events.js";
import type { ModelAccess } from "../engine/model-call.js";
import { createJobQueue, startWorker, type Worker } from "../engine/queue.js";
import { createTasks } from "../engine/tasks.js";
import { createMemoryFileStore } from "../files/store.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

export const BASE_URL = "http://localhost:3000";

/** The real app on the test database, with magic links captured and key validation faked. */
export function createTestHarness(options: { tasks?: TaskList; models?: ModelAccess } = {}) {
  const { db, client, close } = createDb(TEST_DATABASE_URL);
  const events = createEventHub(client);
  const queue = createJobQueue(TEST_DATABASE_URL);
  let runner: Worker | undefined;
  const vault = createKeyVault({ masterKeys: { t1: randomBytes(32) }, activeKid: "t1" });
  const files = createMemoryFileStore();
  const sent: { email: string; url: string }[] = [];
  let keyCheck: KeyCheck = { ok: true };

  const auth = createAuth({
    db,
    baseURL: BASE_URL,
    secret: "test-secret-that-is-long-enough-for-better-auth",
    trustedOrigins: [BASE_URL],
    sendMagicLink: (email, url) => {
      sent.push({ email, url });
    },
  });
  const app = createApp({
    db,
    auth,
    vault,
    events,
    queue,
    files,
    includeUngatedModels: true,
    validateKey: () => Promise.resolve(keyCheck),
  });

  beforeEach(async () => {
    sent.length = 0;
    keyCheck = { ok: true };
    await db.execute(
      "truncate users, sessions, accounts, verifications, allowlist, credentials, usage_events, session_events cascade",
    );
  });
  beforeAll(async () => {
    const tasks = {
      ...(options.models
        ? createTasks({ db, queue, method: loadMethod(), models: options.models })
        : {}),
      ...options.tasks,
    };
    if (Object.keys(tasks).length > 0)
      runner = await startWorker(TEST_DATABASE_URL, tasks, { concurrency: 2 });
  });
  afterAll(async () => {
    await runner?.stop();
    await queue.close();
    await events.close();
    await close();
  });

  /** Polls until the condition holds (for work done by the worker). */
  const waitFor = async (condition: () => Promise<boolean>, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  const request = (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set("cookie", init.cookie);
    // A form sets its own content type, with the boundary.
    if (typeof init.body === "string") headers.set("content-type", "application/json");
    headers.set("origin", BASE_URL);
    return app.request(path.startsWith("http") ? path : `${BASE_URL}${path}`, { ...init, headers });
  };

  /** Signs an allowlisted email in through the magic link; returns the session cookie. */
  const signIn = async (email: string): Promise<string> => {
    await request("/api/auth/sign-in/magic-link", {
      method: "POST",
      body: JSON.stringify({ email, callbackURL: "/" }),
    });
    const link = sent.at(-1);
    if (!link) throw new Error(`no magic link was sent to ${email}`);
    const verified = await request(link.url, { redirect: "manual" });
    return verified.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  };

  return {
    db,
    vault,
    queue,
    files,
    waitFor,
    sent,
    request,
    signIn,
    setKeyCheck: (check: KeyCheck) => {
      keyCheck = check;
    },
  };
}
