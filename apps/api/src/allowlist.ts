import { allowlist, eq, inArray, sessions, users, type Db } from "@grounded/db";

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

/** Removes the invitation and ends the person's sessions immediately. */
export async function revoke(db: Db, email: string): Promise<void> {
  const normalized = normalizeEmail(email);
  await db.delete(allowlist).where(eq(allowlist.email, normalized));
  const people = db.select({ id: users.id }).from(users).where(eq(users.email, normalized));
  await db.delete(sessions).where(inArray(sessions.userId, people));
}
