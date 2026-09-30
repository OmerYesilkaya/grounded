import type { Context, MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { v7 as uuidv7 } from "uuid";
import { log, withLogContext } from "./log.js";
import { isNotice } from "@grounded/core";
import { refuse } from "./refusals.js";

/** A request id from the proxy in front is kept, if it looks like one. */
const REQUEST_ID = /^[\w.:-]{1,100}$/;

/**
 * One line per request: method, route, path, status and duration, in a log context carrying the
 * request id (answered as `x-request-id`) and whatever the handlers add (the user, the session).
 * A 4xx or 5xx line says why, from the response's `error`. The query string is never logged:
 * nothing the line needs is in it, and it is where a token or a learner's words would travel.
 */
export function requestLogging(): MiddlewareHandler {
  return async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : uuidv7();
    await withLogContext({ requestId }, async () => {
      const startedAt = performance.now();
      await next();
      c.header("x-request-id", requestId);
      const { status } = c.res;
      const line = {
        method: c.req.method,
        route: routePath(c),
        path: c.req.path,
        status,
        durationMs: Math.round(performance.now() - startedAt),
        ...(status >= 400 ? { reason: await reasonOf(c) } : {}),
      };
      if (status >= 500) log.error(line, "request failed");
      else if (status >= 400 && status !== 401) log.warn(line, "request refused");
      else log.info(line, "request");
    });
  };
}

/** The reason a refused request was given: the app's own message, never the learner's words. */
async function reasonOf(c: Context): Promise<string | undefined> {
  if (!c.res.headers.get("content-type")?.includes("application/json")) return undefined;
  const body: unknown = await c.res
    .clone()
    .json()
    .catch(() => null);
  if (typeof body !== "object" || body === null) return undefined;
  // A refusal's notice by its code (design §9.3).
  const reason = "error" in body ? body.error : "message" in body ? body.message : undefined;
  if (isNotice(reason)) return reason.code;
  return typeof reason === "string" ? reason.slice(0, 200) : undefined;
}

/** An error no handler caught: logged with its cause chain, answered plainly. */
export function unexpectedError(error: Error, c: Context) {
  log.error({ err: error, route: routePath(c) }, "unexpected error");
  return c.json(refuse("server-error"), 500);
}
