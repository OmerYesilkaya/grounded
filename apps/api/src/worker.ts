import { loadMethod } from "@grounded/core";
import { createKeyVault, parseMasterKeys } from "@grounded/crypto";
import { createDb } from "@grounded/db";
import { createLanguageModel } from "@grounded/providers";
import { createDemoModels } from "./dev/demo-models.js";
import { createModelCaller } from "./engine/model-call.js";
import { createJobQueue, migrateQueue, startWorker } from "./engine/queue.js";
import { recoverAbandonedWork } from "./engine/recovery.js";
import { createTasks } from "./engine/tasks.js";
import { readEnv } from "./env.js";
import { log, setLogService } from "./log.js";

/** The worker process: runs generation jobs, separately from the API (design §4.2). */
setLogService("worker");
const env = readEnv();
const { db } = createDb(env.DATABASE_URL);
const vault = createKeyVault({
  masterKeys: parseMasterKeys(env.KEY_VAULT_MASTER_KEYS),
  activeKid: env.KEY_VAULT_ACTIVE_KID,
});
const queue = createJobQueue(env.DATABASE_URL);

// Before taking jobs, clean up after workers that died mid-job.
await migrateQueue(env.DATABASE_URL);
await recoverAbandonedWork(db);

const runner = await startWorker(
  env.DATABASE_URL,
  createTasks({
    db,
    queue,
    method: loadMethod(),
    models:
      env.DEMO_MODELS === "true"
        ? createDemoModels()
        : createModelCaller({ db, vault, createLanguageModel }),
  }),
  {
    concurrency: 4,
    // Without its work locks, this worker's running jobs look dead to recovery: exit, and be recovered.
    onLocksLost: () => {
      log.fatal("exiting: the next worker start recovers what this one was doing");
      process.exit(1);
    },
  },
);
log.info(
  { concurrency: 4, demoModels: env.DEMO_MODELS === "true" },
  env.DEMO_MODELS === "true" ? "worker running with DEMO models (no real calls)" : "worker running",
);
const stop = () => {
  void runner.stop().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
