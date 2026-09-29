import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "api",
    globalSetup: ["./src/test/global-setup.ts"],
    // A run's files share its database (global-setup.ts); run them one at a time.
    fileParallelism: false,
    // A test drives the real app, worker and Postgres through a journey: some 400 to 2,000 queries
    // one after another. A round trip to Postgres takes about 0.3 ms on an idle machine and several
    // on a busy one, so the slowest tests (0.6 s idle) reach vitest's default 5 s under load.
    testTimeout: 15_000,
  },
});
