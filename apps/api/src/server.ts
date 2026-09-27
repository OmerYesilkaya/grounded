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

const env = readEnv();
const { db, client } = createDb(env.DATABASE_URL);

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
  const email = env.RESEND_API_KEY ? `by email from ${env.EMAIL_FROM}` : "";
  const printed = env.NODE_ENV === "production" ? "" : "printed here";
  console.log(
    `magic links: ${[printed, email].filter(Boolean).join(", and ") || "nowhere (set RESEND_API_KEY)"}`,
  );
});
