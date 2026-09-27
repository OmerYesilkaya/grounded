import { readEnv } from "./env.js";
import { startWorker } from "./engine/queue.js";
import { createTasks } from "./engine/tasks.js";

/** The worker process: runs generation jobs, separately from the API (design §4.2). */
const env = readEnv();
const runner = await startWorker(env.DATABASE_URL, createTasks(), { concurrency: 4 });
console.log("worker running");
const stop = () => {
  void runner.stop().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
