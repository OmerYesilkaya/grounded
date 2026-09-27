import { loadMethod } from "@grounded/core";
import { createKeyVault, parseMasterKeys } from "@grounded/crypto";
import { createDb } from "@grounded/db";
import { createLanguageModel } from "@grounded/providers";
import { createDemoModels } from "./dev/demo-models.js";
import { createModelCaller } from "./engine/model-call.js";
import { createJobQueue, startWorker } from "./engine/queue.js";
import { createTasks } from "./engine/tasks.js";
import { readEnv } from "./env.js";

/** The worker process: runs generation jobs, separately from the API (design §4.2). */
const env = readEnv();
const { db } = createDb(env.DATABASE_URL);
const vault = createKeyVault({
  masterKeys: parseMasterKeys(env.KEY_VAULT_MASTER_KEYS),
  activeKid: env.KEY_VAULT_ACTIVE_KID,
});
const queue = createJobQueue(env.DATABASE_URL);
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
  { concurrency: 4 },
);
console.log(
  env.DEMO_MODELS === "true" ? "worker running with DEMO models (no real calls)" : "worker running",
);
const stop = () => {
  void runner.stop().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
