import { serve } from "@hono/node-server";
import { createKeyVault, parseMasterKeys } from "@grounded/crypto";
import { createDb } from "@grounded/db";
import { validateKey } from "@grounded/providers";
import { createApp } from "./app.js";
import { createAuth } from "./auth.js";
import { readEnv } from "./env.js";

const env = readEnv();
const { db } = createDb(env.DATABASE_URL);

const auth = createAuth({
  db,
  baseURL: env.APP_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.APP_URL],
  // Development: the link goes to the console. An email provider replaces this when deployed.
  sendMagicLink: (email, url) => {
    console.log(`\nMagic link for ${email}:\n${url}\n`);
  },
});

const app = createApp({
  db,
  auth,
  vault: createKeyVault({
    masterKeys: parseMasterKeys(env.KEY_VAULT_MASTER_KEYS),
    activeKid: env.KEY_VAULT_ACTIVE_KID,
  }),
  includeUngatedModels: env.ALLOW_UNGATED_MODELS === "true",
  validateKey: (provider, apiKey) => validateKey(provider, apiKey),
});

serve({ fetch: app.fetch, port: env.PORT }, ({ port }) => {
  console.log(`api listening on http://localhost:${String(port)}`);
});
