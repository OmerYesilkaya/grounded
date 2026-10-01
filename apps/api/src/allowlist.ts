import { allowlist, eq, type Db } from "@grounded/db";
import { hashInviteCode, inviteCodeMatches, mintInviteCode } from "./invite-code.js";

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * Invites the email, or re-invites it, minting its invite code: the one thing that is returned
 * here and nowhere else. Only the code's hash is stored, so inviting again is how a lost code is
 * replaced; the old one stops working at once.
 */
export async function invite(db: Db, email: string): Promise<string> {
  const code = mintInviteCode();
  const issued = { codeHash: hashInviteCode(code), codeIssuedAt: new Date() };
  await db
    .insert(allowlist)
    .values({ email: normalizeEmail(email), ...issued })
    .onConflictDoUpdate({ target: allowlist.email, set: issued });
  return code;
}

/** Whether the email is invited and the code is its current one. */
export async function invitedWith(db: Db, email: string, code: string): Promise<boolean> {
  const [row] = await db
    .select({ codeHash: allowlist.codeHash })
    .from(allowlist)
    .where(eq(allowlist.email, normalizeEmail(email)));
  return row?.codeHash != null && inviteCodeMatches(code, row.codeHash);
}

/** Removes the invitation; every request checks it, so the person is out at once. */
export async function revoke(db: Db, email: string): Promise<void> {
  await db.delete(allowlist).where(eq(allowlist.email, normalizeEmail(email)));
}

/** Everyone invited, with when, and when their current code was issued (never the code). */
export function listInvited(db: Db) {
  return db
    .select({
      email: allowlist.email,
      invitedAt: allowlist.invitedAt,
      codeIssuedAt: allowlist.codeIssuedAt,
    })
    .from(allowlist)
    .orderBy(allowlist.invitedAt);
}
