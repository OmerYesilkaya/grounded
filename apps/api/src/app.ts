import type { KeyVault } from "@grounded/crypto";
import { credentials, eq, type Db } from "@grounded/db";
import { offeredModels, type KeyCheck, type ProviderId } from "@grounded/providers";
import { Hono } from "hono";
import { z } from "zod";
import type { Auth } from "./auth.js";

export interface AppDependencies {
  db: Db;
  auth: Auth;
  vault: KeyVault;
  /** Offer models the eval harness hasn't passed (development only). */
  includeUngatedModels: boolean;
  validateKey: (provider: ProviderId, apiKey: string) => Promise<KeyCheck>;
}

interface Variables {
  user: { id: string; email: string; name: string };
}

const PROVIDERS = ["anthropic", "openai", "google"] as const satisfies readonly ProviderId[];

const credentialInput = z.object({
  provider: z.enum(PROVIDERS),
  model: z.string().min(1),
  apiKey: z.string().trim().min(8),
});

export function createApp(deps: AppDependencies) {
  const { db, auth, vault } = deps;
  const app = new Hono<{ Variables: Variables }>();

  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  app.use("/api/*", async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "Sign in first." }, 401);
    c.set("user", { id: session.user.id, email: session.user.email, name: session.user.name });
    await next();
  });

  app.get("/api/me", (c) => c.json(c.get("user")));

  app.get("/api/models", (c) =>
    c.json(
      Object.fromEntries(
        PROVIDERS.map((provider) => [
          provider,
          offeredModels(provider, { includeUngated: deps.includeUngatedModels }).map(
            ({ id, label }) => ({ id, label }),
          ),
        ]),
      ),
    ),
  );

  app.get("/api/credentials", async (c) => {
    const [row] = await db
      .select()
      .from(credentials)
      .where(eq(credentials.userId, c.get("user").id));
    return c.json(row ? publicCredential(row) : null);
  });

  app.put("/api/credentials", async (c) => {
    const parsed = credentialInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: "Choose a provider and a model, and paste your API key." }, 400);
    const { provider, model, apiKey } = parsed.data;
    const offered = offeredModels(provider, { includeUngated: deps.includeUngatedModels });
    if (!offered.some((m) => m.id === model)) {
      return c.json({ error: "That model isn't available for this provider." }, 400);
    }

    const check = await deps.validateKey(provider, apiKey);
    if (!check.ok) return c.json({ error: check.message, kind: check.kind }, 422);

    const userId = c.get("user").id;
    const values = {
      userId,
      provider,
      model,
      sealedKey: vault.seal(apiKey, userId),
      keyHint: apiKey.slice(-4),
    };
    const [row] = await db
      .insert(credentials)
      .values(values)
      .onConflictDoUpdate({ target: credentials.userId, set: { ...values, source: "own_key" } })
      .returning();
    if (!row) throw new Error("credential upsert returned nothing");
    return c.json(publicCredential(row));
  });

  app.delete("/api/credentials", async (c) => {
    await db.delete(credentials).where(eq(credentials.userId, c.get("user").id));
    return c.body(null, 204);
  });

  return app;
}

/** Everything the browser may see about a credential: never the key, sealed or not. */
function publicCredential(row: typeof credentials.$inferSelect) {
  return { provider: row.provider, model: row.model, keyHint: row.keyHint, source: row.source };
}
