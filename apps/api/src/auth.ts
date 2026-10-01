import { allowlist, eq, users, type Db } from "@grounded/db";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { z } from "zod";
import { invitedWith, normalizeEmail } from "./allowlist.js";
import { refuse } from "./refusals.js";

/*
 * Sign-in by email and invite code (design §4.3): an email on the allowlist signs in by typing it
 * with the code Omer handed over in person, and stays signed in for good. The browser holds a
 * cookie with the user's id, signed with the secret; each request looks the user up and checks the
 * email is still on the allowlist, so revoking an invitation ends access at once. Nothing is
 * emailed and no token expires. The code is what keeps someone who merely knows an invited email
 * out of the account, and so away from the API key it pays with.
 */

export interface AuthOptions {
  db: Db;
  /** Signs the cookie; a forged or edited cookie fails its signature. */
  secret: string;
  /** Send the cookie only over HTTPS (production; the app is served over https there). */
  secure: boolean;
}

export interface SignedInUser {
  id: string;
  email: string;
}

export const SESSION_COOKIE = "grounded_session";

/**
 * Browsers cap a cookie's life at 400 days. Each visit renews it (`renewSession`, on `/api/me`,
 * which every page load asks), so it never runs out for anyone who keeps coming back.
 */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

const cookieOptions = (secure: boolean) => ({
  path: "/",
  httpOnly: true,
  secure,
  sameSite: "Lax" as const,
  maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
});

const signInInput = z.object({ email: z.string().trim().min(1), code: z.string().trim().min(1) });

/**
 * The person an email and code sign in as, if the email is invited and the code is its current
 * one: their user row, created on their first sign-in (signing in is signing up). Null otherwise,
 * without saying which of the two was wrong, so the allowlist can't be probed email by email.
 */
export async function signIn(db: Db, rawEmail: string, code: string): Promise<SignedInUser | null> {
  const email = normalizeEmail(rawEmail);
  if (!(await invitedWith(db, email, code))) return null;
  await db.insert(users).values({ email }).onConflictDoNothing();
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, email));
  if (!user) throw new Error(`no user row for ${email} after signing in`);
  return user;
}

/** Who the request's cookie names, if it is intact and the email is still invited. */
export async function signedInUser(c: Context, options: AuthOptions): Promise<SignedInUser | null> {
  const userId = await getSignedCookie(c, options.secret, SESSION_COOKIE);
  if (!userId || !z.uuid().safeParse(userId).success) return null;
  const [user] = await options.db
    .select({ id: users.id, email: users.email })
    .from(users)
    .innerJoin(allowlist, eq(allowlist.email, users.email))
    .where(eq(users.id, userId));
  return user ?? null;
}

/** Sets (or renews) the session cookie for the user. */
export function setSession(c: Context, options: AuthOptions, user: SignedInUser): Promise<void> {
  return setSignedCookie(c, SESSION_COOKIE, user.id, options.secret, cookieOptions(options.secure));
}

/** Refuses a request without an intact cookie naming an invited person; sets `user` otherwise. */
export function requireSignIn(
  options: AuthOptions,
): MiddlewareHandler<{ Variables: { user: SignedInUser } }> {
  return async (c, next) => {
    const user = await signedInUser(c, options);
    if (!user) return c.json(refuse("sign-in-first"), 401);
    c.set("user", user);
    await next();
  };
}

/** Sign-in and sign-out, open to anyone; mounted before `requireSignIn` guards the rest. */
export function registerAuthRoutes(
  app: Hono<{ Variables: { user: SignedInUser } }>,
  options: AuthOptions,
): void {
  app.post("/api/auth/sign-in", async (c) => {
    const parsed = signInInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(refuse("enter-email-and-code"), 400);
    const user = await signIn(options.db, parsed.data.email, parsed.data.code);
    if (!user) return c.json(refuse("email-or-code-wrong"), 403);
    await setSession(c, options, user);
    return c.json(user);
  });

  app.post("/api/auth/sign-out", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: options.secure });
    return c.body(null, 204);
  });
}
