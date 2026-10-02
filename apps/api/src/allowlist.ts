import { allowlist, eq, sql, users, type Db } from "@grounded/db";
import { hashInviteCode, mintInviteCode } from "./invite-code.js";

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * Invites the email, or re-invites it, minting its one-time invite code: the one thing that is
 * returned here and nowhere else. Only the code's hash is stored, so inviting again is how a lost
 * code or a forgotten password is replaced: the old code stops at once, and any password the
 * person had is cleared, so they sign in with the new code and choose a password again.
 */
export async function invite(db: Db, rawEmail: string): Promise<string> {
  const email = normalizeEmail(rawEmail);
  const code = mintInviteCode();
  const issued = { codeHash: hashInviteCode(code), codeIssuedAt: new Date() };
  await db.transaction(async (tx) => {
    await tx
      .insert(allowlist)
      .values({ email, ...issued })
      .onConflictDoUpdate({ target: allowlist.email, set: issued });
    await tx
      .update(users)
      .set({ passwordHash: null, passwordSetAt: null, signInFailures: 0, lockedUntil: null })
      .where(eq(users.email, email));
  });
  return code;
}

/** Removes the invitation; every request checks it, so the person is out at once. */
export async function revoke(db: Db, email: string): Promise<void> {
  await db.delete(allowlist).where(eq(allowlist.email, normalizeEmail(email)));
}

/** Everyone invited, with when, and where their sign-in stands (never the code or password). */
export function listInvited(db: Db) {
  return db
    .select({
      email: allowlist.email,
      invitedAt: allowlist.invitedAt,
      codeIssuedAt: allowlist.codeIssuedAt,
      codePending: sql<boolean>`${allowlist.codeHash} is not null`,
      passwordSetAt: users.passwordSetAt,
    })
    .from(allowlist)
    .leftJoin(users, eq(users.email, allowlist.email))
    .orderBy(allowlist.invitedAt);
}
