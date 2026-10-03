import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    name: "admin",
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
