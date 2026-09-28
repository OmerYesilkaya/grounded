import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "eval",
    // The drive test runs the real backend on a database of its own; give it room.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
