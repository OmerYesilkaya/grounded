import type { KeyVault } from "@grounded/crypto";
import { and, credentials, eq, learningSessions, sql, type Db } from "@grounded/db";
import { offeredModels, type KeyCheck, type ProviderId } from "@grounded/providers";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Auth } from "./auth.js";
import { eventsAfter, type EventHub } from "./engine/events.js";
import type { JobQueue } from "./engine/queue.js";
import { registerSessionRoutes } from "./routes/sessions.js";

export interface AppDependencies {
  db: Db;
  auth: Auth;
  vault: KeyVault;
  events: EventHub;
  queue: JobQueue;
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

  /** For the host's deploy check: the process is up and reaches the database. */
  app.get("/healthz", async (c) => {
    await db.execute(sql`select 1`);
    return c.text("ok");
  });

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

  /** The session's event log over SSE: replayed after Last-Event-ID, then live. */
  app.get("/api/sessions/:id/stream", async (c) => {
    const sessionId = c.req.param("id");
    if (!z.uuid().safeParse(sessionId).success) return c.json({ error: "Not found." }, 404);
    const [session] = await db
      .select({ id: learningSessions.id })
      .from(learningSessions)
      .where(
        and(eq(learningSessions.id, sessionId), eq(learningSessions.userId, c.get("user").id)),
      );
    if (!session) return c.json({ error: "Not found." }, 404);
    const lastId = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? 0) || 0;

    return streamSSE(c, async (stream) => {
      let cursor = lastId;
      let dirty = true;
      let wake: (() => void) | null = null;
      const signal = () => {
        dirty = true;
        wake?.();
      };
      // Subscribe before replaying, so nothing published in between is missed.
      const unsubscribe = await deps.events.subscribe(sessionId, signal);
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      // Read through a function: an abort can flip this while we wait.
      const aborted = () => stream.aborted;
      while (!aborted()) {
        if (dirty) {
          dirty = false;
          for (const event of await eventsAfter(db, sessionId, cursor)) {
            await stream.writeSSE({
              id: String(event.id),
              event: event.type,
              data: JSON.stringify(event.data),
            });
            cursor = event.id;
          }
          continue;
        }
        const heartbeat = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            resolve(true);
          }, 15_000);
          wake = () => {
            clearTimeout(timer);
            resolve(false);
          };
        });
        wake = null;
        if (heartbeat && !aborted()) await stream.write(": keep-alive\n\n");
      }
    });
  });

  registerSessionRoutes(app, { db, queue: deps.queue });

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
