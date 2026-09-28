import { serve } from "@hono/node-server";
import { createKeyVault, parseMasterKeys } from "@grounded/crypto";
import { createDb } from "@grounded/db";
import { validateKey } from "@grounded/providers";
import { createApp } from "./app.js";
import { createAuth } from "./auth.js";
import { createMagicLinkDelivery, createResendSender } from "./email.js";
import { createEventHub } from "./engine/events.js";
import { createJobQueue } from "./engine/queue.js";
import { readEnv } from "./env.js";
import { fileStoreFor } from "./files/from-env.js";
import { log, setLogService } from "./log.js";
import { serveWeb } from "./web.js";

setLogService("api");
const env = readEnv();
const { db, client, close } = createDb(env.DATABASE_URL);
const events = createEventHub(client);
const queue = createJobQueue(env.DATABASE_URL);

const auth = createAuth({
  db,
  baseURL: env.APP_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.APP_URL],
  sendMagicLink: createMagicLinkDelivery({
    email: env.RESEND_API_KEY
      ? createResendSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM })
      : undefined,
    printLinks: env.NODE_ENV !== "production",
  }),
});

const app = createApp({
  db,
  auth,
  events,
  queue,
  files: fileStoreFor(env),
  vault: createKeyVault({
    masterKeys: parseMasterKeys(env.KEY_VAULT_MASTER_KEYS),
    activeKid: env.KEY_VAULT_ACTIVE_KID,
  }),
  includeUngatedModels: env.ALLOW_UNGATED_MODELS === "true",
  validateKey: (provider, apiKey) => validateKey(provider, apiKey),
});

if (env.WEB_DIST_DIR) serveWeb(app, env.WEB_DIST_DIR);

const server = serve({ fetch: app.fetch, port: env.PORT }, ({ port }) => {
  log.info({ port }, `api listening on http://localhost:${String(port)}`);
  const email = env.RESEND_API_KEY ? `by email from ${env.EMAIL_FROM}` : "";
  const printed = env.NODE_ENV === "production" ? "" : "printed here";
  log.info(
    `magic links: ${[printed, email].filter(Boolean).join(", and ") || "nowhere (set RESEND_API_KEY)"}`,
  );
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
