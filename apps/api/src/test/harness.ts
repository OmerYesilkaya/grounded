import type { KeyCheck } from "@grounded/providers";
import type { TaskList } from "graphile-worker";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { createEmbedded } from "../embedded.js";
import type { ModelAccess } from "../engine/model-call.js";
import { TEST_DATABASE_URL } from "./database.js";

export { BASE_URL } from "../embedded.js";

/** The real app on the test database, with magic links captured and key validation faked. */
export function createTestHarness(options: { tasks?: TaskList; models?: ModelAccess } = {}) {
  let keyCheck: KeyCheck = { ok: true };
  const backend = createEmbedded({
    databaseUrl: TEST_DATABASE_URL,
    ...(options.models ? { models: options.models } : {}),
    ...(options.tasks ? { tasks: options.tasks } : {}),
    validateKey: () => Promise.resolve(keyCheck),
  });
  const { db, sent, waitFor, workerIdle } = backend;

  beforeEach(async () => {
    sent.length = 0;
    keyCheck = { ok: true };
    // A test can end while a job it started still writes, and truncating under it deadlocks.
    await waitFor(workerIdle, 9_000);
    await db.execute(
      "truncate users, sessions, accounts, verifications, allowlist, credentials, usage_events, session_events cascade",
    );
  });
  beforeAll(backend.startWorker);
  afterAll(backend.stop);

  return {
    db,
    vault: backend.vault,
    queue: backend.queue,
    files: backend.files,
    waitFor,
    sent,
    request: backend.request,
    signIn: backend.signIn,
    setKeyCheck: (check: KeyCheck) => {
      keyCheck = check;
    },
  };
}
