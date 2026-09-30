import { allowlist, eq, type Db } from "@grounded/db";

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export async function isInvited(db: Db, email: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(allowlist)
    .where(eq(allowlist.email, normalizeEmail(email)));
  return rows.length > 0;
}

export async function invite(db: Db, email: string): Promise<void> {
  await db
    .insert(allowlist)
    .values({ email: normalizeEmail(email) })
    .onConflictDoNothing();
}

/** Removes the invitation; every request checks it, so the person is out at once. */
export async function revoke(db: Db, email: string): Promise<void> {
  await db.delete(allowlist).where(eq(allowlist.email, normalizeEmail(email)));
}
