import { refusal } from "@grounded/core";
import { allowlist, eq, sql, users, type Db } from "@grounded/db";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { z } from "zod";
import { normalizeEmail } from "./allowlist.js";
import { inviteCodeMatches } from "./invite-code.js";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, type PasswordHasher } from "./password.js";
import { refuse } from "./refusals.js";

/*
 * Sign-in by email and password (design §4.3). The first time, the password is the one-time invite
 * code Omer handed over in person; it signs the person in and the app has them choose a password
 * before anything else, which ends the code. From then on it is email and that password; a
 * forgotten one is replaced by Omer inviting again. Wrong passwords are counted per learner and
 * lock sign-in for a while, since a chosen password can be guessed where a random code can't.
 * Once in, the browser holds a cookie with the user's id, signed with the secret; each request
 * looks the user up and checks the email is still on the allowlist, so revoking an invitation
 * ends access at once. Nothing is emailed and no token expires.
 */

export interface AuthOptions {
  db: Db;
  /** Signs the cookie; a forged or edited cookie fails its signature. */
  secret: string;
  /** Send the cookie only over HTTPS (production; the app is served over https there). */
  secure: boolean;
  passwords: PasswordHasher;
}

export interface SignedInUser {
  id: string;
  email: string;
  /** False until they choose a password: the app asks for one before anything else. */
  passwordSet: boolean;
}

export const SESSION_COOKIE = "grounded_session";

/**
 * Browsers cap a cookie's life at 400 days. Each visit renews it (`renewSession`, on `/api/me`,
 * which every page load asks), so it never runs out for anyone who keeps coming back.
 */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/** This many wrong passwords in a row lock sign-in for the while below. */
export const MAX_SIGN_IN_FAILURES = 10;
export const LOCK_MINUTES = 15;

const cookieOptions = (secure: boolean) => ({
  path: "/",
  httpOnly: true,
  secure,
  sameSite: "Lax" as const,
  maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
});

const signInInput = z.object({
  email: z.string().trim().min(1),
  password: z.string().min(1),
});

const password = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);
const passwordInput = z.object({ password, current: z.string().optional() });

const passwordSet = sql<boolean>`${users.passwordHash} is not null`;

export type SignInOutcome =
  | { kind: "signed-in"; user: SignedInUser }
  /** The email and password (or code) match no invitation; which was wrong is not said. */
  | { kind: "refused" }
  /** Too many wrong passwords lately. */
  | { kind: "locked" };

/**
 * Who an email and password sign in as. With a password chosen, it must be that; without one, the
 * password is the invite code, and the user row is created on this first sign-in (signing in is
 * signing up). Refusals don't say which of the two was wrong, and take as long either way, so the
 * allowlist can't be probed email by email.
 */
export async function signIn(
  options: AuthOptions,
  rawEmail: string,
  secret: string,
): Promise<SignInOutcome> {
  const { db, passwords } = options;
  const email = normalizeEmail(rawEmail);
  const [row] = await db
    .select({
      codeHash: allowlist.codeHash,
      user: {
        id: users.id,
        passwordHash: users.passwordHash,
        signInFailures: users.signInFailures,
        lockedUntil: users.lockedUntil,
      },
    })
    .from(allowlist)
    .leftJoin(users, eq(users.email, allowlist.email))
    .where(eq(allowlist.email, email));

  const user = row?.user;
  const passwordHash = user?.passwordHash;
  if (user && passwordHash) {
    if (user.lockedUntil && user.lockedUntil > new Date()) return { kind: "locked" };
    if (await passwords.verify(secret, passwordHash)) {
      await db
        .update(users)
        .set({ signInFailures: 0, lockedUntil: null })
        .where(eq(users.id, user.id));
      return { kind: "signed-in", user: { id: user.id, email, passwordSet: true } };
    }
    await recordFailure(db, user.id, user.signInFailures);
    return { kind: "refused" };
  }

  // No password to check: spend the time one would take, so timing tells nothing.
  await passwords.spendVerifyTime();
  const codeHash = row?.codeHash;
  if (!codeHash || !inviteCodeMatches(secret, codeHash)) return { kind: "refused" };
  await db.insert(users).values({ email }).onConflictDoNothing();
  const [created] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (!created) throw new Error(`no user row for ${email} after signing in`);
  return { kind: "signed-in", user: { id: created.id, email, passwordSet: false } };
}

/** One more wrong password; the one that reaches the limit locks sign-in and starts the count over. */
async function recordFailure(db: Db, userId: string, failuresSoFar: number): Promise<void> {
  const failures = failuresSoFar + 1;
  await db
    .update(users)
    .set(
      failures >= MAX_SIGN_IN_FAILURES
        ? { signInFailures: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) }
        : { signInFailures: failures },
    )
    .where(eq(users.id, userId));
}

/** Who the request's cookie names, if it is intact and the email is still invited. */
export async function signedInUser(c: Context, options: AuthOptions): Promise<SignedInUser | null> {
  const userId = await getSignedCookie(c, options.secret, SESSION_COOKIE);
  if (!userId || !z.uuid().safeParse(userId).success) return null;
  const [user] = await options.db
    .select({ id: users.id, email: users.email, passwordSet })
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
    if (!parsed.success) return c.json(refuse("enter-email-and-password"), 400);
    const outcome = await signIn(options, parsed.data.email, parsed.data.password);
    if (outcome.kind === "locked") return c.json(refuse("too-many-attempts"), 429);
    if (outcome.kind === "refused") return c.json(refuse("email-or-password-wrong"), 403);
    await setSession(c, options, outcome.user);
    return c.json(outcome.user);
  });

  app.post("/api/auth/sign-out", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: options.secure });
    return c.body(null, 204);
  });
}

/**
 * Choosing and changing the password, for whoever is signed in; mounted behind `requireSignIn`.
 * Choosing the first one ends the invite code. Changing it takes the current one, counted and
 * locked like sign-in, so a session left open on someone's device can't be turned into the
 * password by guessing.
 */
export function registerPasswordRoutes(
  app: Hono<{ Variables: { user: SignedInUser } }>,
  options: AuthOptions,
): void {
  const { db, passwords } = options;
  app.put("/api/auth/password", async (c) => {
    const parsed = passwordInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        refusal({ code: "password-length", min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH }),
        400,
      );
    const { id, email } = c.get("user");
    const [user] = await db
      .select({
        passwordHash: users.passwordHash,
        signInFailures: users.signInFailures,
        lockedUntil: users.lockedUntil,
      })
      .from(users)
      .where(eq(users.id, id));
    if (!user) return c.json(refuse("sign-in-first"), 401);

    if (user.passwordHash) {
      if (user.lockedUntil && user.lockedUntil > new Date())
        return c.json(refuse("too-many-attempts"), 429);
      if (!(await passwords.verify(parsed.data.current ?? "", user.passwordHash))) {
        await recordFailure(db, id, user.signInFailures);
        return c.json(refuse("current-password-wrong"), 403);
      }
    }

    const passwordHash = await passwords.hash(parsed.data.password);
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash, passwordSetAt: new Date(), signInFailures: 0, lockedUntil: null })
        .where(eq(users.id, id));
      await tx.update(allowlist).set({ codeHash: null }).where(eq(allowlist.email, email));
    });
    const signedIn: SignedInUser = { id, email, passwordSet: true };
    return c.json(signedIn);
  });
}
