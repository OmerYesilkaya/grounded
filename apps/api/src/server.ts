import { serve } from "@hono/node-server";
import { createKeyVault, parseMasterKeys } from "@grounded/crypto";
import { createDb } from "@grounded/db";
import { validateKey } from "@grounded/providers";
import { createApp } from "./app.js";
import { createAuth } from "./auth.js";
import { consoleSender, createResendSender } from "./email.js";
import { createEventHub } from "./engine/events.js";
import { createJobQueue } from "./engine/queue.js";
import { readEnv } from "./env.js";

const env = readEnv();
const { db, client } = createDb(env.DATABASE_URL);

const auth = createAuth({
  db,
  baseURL: env.APP_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.APP_URL],
  sendMagicLink: env.RESEND_API_KEY
    ? createResendSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM })
    : consoleSender,
});

const app = createApp({
  db,
  auth,
  events: createEventHub(client),
  queue: createJobQueue(env.DATABASE_URL),
  vault: createKeyVault({
    masterKeys: parseMasterKeys(env.KEY_VAULT_MASTER_KEYS),
    activeKid: env.KEY_VAULT_ACTIVE_KID,
  }),
  includeUngatedModels: env.ALLOW_UNGATED_MODELS === "true",
  validateKey: (provider, apiKey) => validateKey(provider, apiKey),
});

serve({ fetch: app.fetch, port: env.PORT }, ({ port }) => {
  console.log(`api listening on http://localhost:${String(port)}`);
  console.log(
    env.RESEND_API_KEY
      ? `magic links by email from ${env.EMAIL_FROM}`
      : "magic links in this console (no RESEND_API_KEY)",
  );
});
