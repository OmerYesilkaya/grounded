import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // The API is reached through the web origin, so cookies and CORS stay simple.
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        configure: (proxy) => {
          // When the API goes away mid-response (a restart), end the browser's side too. Otherwise a
          // session stream hangs open with nothing arriving, and EventSource never reconnects.
          proxy.on("proxyRes", (proxyRes, _req, res) => {
            proxyRes.on("close", () => {
              if (!proxyRes.complete) res.destroy();
            });
          });
        },
      },
    },
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
