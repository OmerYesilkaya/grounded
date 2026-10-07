import { serve } from "@hono/node-server";
import { createKeyVault, parseMasterKeys } from "@grounded/crypto";
import { createDb } from "@grounded/db";
import { validateKey } from "@grounded/providers";
import { createApp } from "./app.js";
import { createEventHub } from "./engine/events.js";
import { createJobQueue } from "./engine/queue.js";
import { readEnv } from "./env.js";
import { fileStoreFor } from "./files/from-env.js";
import { log, setLogService } from "./log.js";
import { createPasswordHasher } from "./password.js";
import { serveAdmin, serveWeb } from "./web.js";

setLogService("api");
const env = readEnv();
const { db, client, close } = createDb(env.DATABASE_URL);
const events = createEventHub(client);
const queue = createJobQueue(env.DATABASE_URL);

const app = createApp({
  db,
  // The cookie goes only over HTTPS where the app is served over it.
  auth: {
    secret: env.AUTH_SECRET,
    secure: env.APP_URL.startsWith("https:"),
    passwords: createPasswordHasher(),
  },
  events,
  queue,
  files: fileStoreFor(env),
  vault: createKeyVault({
    masterKeys: parseMasterKeys(env.KEY_VAULT_MASTER_KEYS),
    activeKid: env.KEY_VAULT_ACTIVE_KID,
  }),
  includeUngatedModels: env.ALLOW_UNGATED_MODELS === "true",
  devTools: env.NODE_ENV !== "production",
  validateKey: (provider, apiKey) => validateKey(provider, apiKey),
});

if (env.ADMIN_DIST_DIR) serveAdmin(app, env.ADMIN_DIST_DIR);
if (env.WEB_DIST_DIR) serveWeb(app, env.WEB_DIST_DIR);

const server = serve({ fetch: app.fetch, port: env.PORT }, ({ port }) => {
  log.info({ port }, `api listening on http://localhost:${String(port)}`);
});

// On a deploy or restart: stop taking requests and end the open streams (browsers reconnect to
// another process and replay from their last event id), then let go of the database.
const stop = () => {
  log.info("api stopping");
  server.close(() => {
    void Promise.all([events.close(), queue.close()])
      .then(close)
      .finally(() => process.exit(0));
  });
  if ("closeAllConnections" in server) server.closeAllConnections();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
