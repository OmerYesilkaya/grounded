import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "api",
    globalSetup: ["./src/test/global-setup.ts"],
    // A run's files share its database (global-setup.ts); run them one at a time.
    fileParallelism: false,
  },
});
