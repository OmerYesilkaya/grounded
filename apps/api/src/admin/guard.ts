import { allowlist, eq, type Db } from "@grounded/db";
import type { MiddlewareHandler } from "hono";
import type { SignedInUser } from "../auth.js";
import { notFound } from "../refusals.js";

/**
 * Lets only operators through (design §10.1), behind `requireSignIn`. Anyone else is answered 404,
 * as if the admin panel weren't there.
 */
export function requireOperator(db: Db): MiddlewareHandler<{ Variables: { user: SignedInUser } }> {
  return async (c, next) => {
    const [row] = await db
      .select({ operator: allowlist.operator })
      .from(allowlist)
      .where(eq(allowlist.email, c.get("user").email));
    if (!row?.operator) return c.json(notFound, 404);
    await next();
  };
}
