import { serveStatic } from "@hono/node-server/serve-static";
import type { Env, Hono, MiddlewareHandler } from "hono";

/**
 * Serves the built web app from `root`, so the app and /api share one origin in production (design
 * §4.2). Vite fingerprints everything under /assets, so it is cached for good and a missing asset is a
 * 404. Any other path that isn't a file gets index.html, uncached, and the client router takes it from
 * there. /api paths are never answered with the app.
 */
export function serveWeb<E extends Env>(app: Hono<E>, root: string) {
  app.use("/assets/*", cached(FOREVER, serveStatic({ root })));
  app.get("/assets/*", (c) => c.notFound());
  app.use("*", outsideApi(cached(NO_CACHE, serveStatic({ root }))));
  app.get("*", outsideApi(cached(NO_CACHE, serveStatic({ root, path: "index.html" }))));
}

const FOREVER = "public, max-age=31536000, immutable";
const NO_CACHE = "no-cache";

/** Sets Cache-Control on the file `serve` found; when it finds none it passes on, and returns no Response. */
const cached =
  (value: string, serve: MiddlewareHandler): MiddlewareHandler =>
  async (c, next) => {
    const res = await serve(c, next);
    if (res instanceof Response) res.headers.set("Cache-Control", value);
    return res;
  };

const outsideApi =
  (handler: MiddlewareHandler): MiddlewareHandler =>
  (c, next) =>
    c.req.path === "/api" || c.req.path.startsWith("/api/") ? next() : handler(c, next);
