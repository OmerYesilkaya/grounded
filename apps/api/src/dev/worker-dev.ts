import { spawn, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";

/*
 * The worker in development (`pnpm dev:worker`): restarted when the code changes, as `tsx watch`
 * would, and also when it exits with an error. The worker exits when it loses the connection that
 * holds its work locks (a Postgres restart, say; design §4.2), and `tsx watch` would leave it down
 * until the next edit. A worker that fails within seconds of starting (it doesn't compile) waits for
 * a change instead of restarting in a loop.
 */

const API = fileURLToPath(new URL("../..", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const WATCHED = [`${API}src`, `${ROOT}packages`, `${ROOT}method.md`];
const RESTART_AFTER_MS = 1000;
/** A worker that fails sooner than this after starting won't do better on its own. */
const FAILS_AT_ONCE_MS = 5000;

let child: ChildProcess | undefined;
let startedAt = 0;
let stopping = false;

function start() {
  startedAt = Date.now();
  const worker = spawn(
    process.execPath,
    ["--env-file-if-exists=../../.env", "--import", "tsx", "src/worker.ts"],
    { cwd: API, stdio: "inherit" },
  );
  child = worker;
  worker.on("exit", (code, signal) => {
    if (child !== worker) return;
    child = undefined;
    if (stopping) process.exit(0);
    const how = signal ?? `exit ${String(code)}`;
    if (Date.now() - startedAt < FAILS_AT_ONCE_MS) {
      console.error(`[worker-dev] the worker failed at once (${how}); waiting for a change`);
      return;
    }
    console.error(`[worker-dev] the worker stopped (${how}); restarting`);
    setTimeout(start, RESTART_AFTER_MS);
  });
}

/** Stops the running worker (it finishes its jobs) and starts a new one. */
function restart() {
  const running = child;
  if (!running) {
    start();
    return;
  }
  child = undefined;
  running.once("exit", start);
  running.kill("SIGTERM");
}

let pending: ReturnType<typeof setTimeout> | undefined;
for (const path of WATCHED) {
  watch(path, { recursive: true }, (_event, file) => {
    if (file && /node_modules|\.test\.tsx?$/.test(file)) return;
    clearTimeout(pending);
    pending = setTimeout(restart, 200);
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    if (child) child.kill(signal);
    else process.exit(0);
  });
}

start();
