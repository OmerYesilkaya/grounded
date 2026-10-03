import { serveStatic } from "@hono/node-server/serve-static";
import type { Env, Hono, MiddlewareHandler } from "hono";

/**
 * Serves the built web app from `root`, so the app and /api share one origin in production (design
 * §4.2). Vite fingerprints everything under /assets, so it is cached for good and a missing asset is a
 * 404. Any other path that isn't a file gets index.html, uncached, and the client router takes it from
 * there. /api paths are never answered with the app.
 */
export function serveWeb<E extends Env>(app: Hono<E>, root: string) {
  serveApp(app, root, "");
}

/**
 * Serves the built admin panel (design §10.1) from `root` at /admin, the same way and on the same
 * origin, so the app's session cookie signs the operator in. Mounted before the web app, whose
 * catch-all would otherwise answer /admin.
 */
export function serveAdmin<E extends Env>(app: Hono<E>, root: string) {
  serveApp(app, root, "/admin");
}

function serveApp<E extends Env>(app: Hono<E>, root: string, base: string) {
  const files = { root, rewriteRequestPath: (path: string) => path.slice(base.length) || "/" };
  app.use(`${base}/assets/*`, cached(FOREVER, serveStatic(files)));
  app.get(`${base}/assets/*`, (c) => c.notFound());
  if (base) app.get(base, (c) => c.redirect(`${base}/`));
  const scope = base ? `${base}/*` : "*";
  app.use(scope, outsideApi(cached(NO_CACHE, serveStatic(files))));
  app.get(scope, outsideApi(cached(NO_CACHE, serveStatic({ root, path: "index.html" }))));
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
