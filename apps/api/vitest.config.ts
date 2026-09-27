import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "api",
    globalSetup: ["./src/test/global-setup.ts"],
    // Tests share one database; run files one at a time.
    fileParallelism: false,
  },
});
