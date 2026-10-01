import { createHash, randomInt, timingSafeEqual } from "node:crypto";

/*
 * The invite code (design §4.3): what an invited person types beside their email. Omer mints it
 * (`pnpm cli invite`) and hands it over in person; the database keeps only its hash. Four groups
 * of four from an alphabet of 31 is about 79 bits, so a plain hash is enough and guessing is
 * hopeless without any throttle.
 */

/** No look-alikes: i, l, o, 0 and 1 are left out, so a code read aloud or retyped survives. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const GROUPS = 4;
const GROUP_LENGTH = 4;

/** A fresh code, as it is handed over: `xxxx-xxxx-xxxx-xxxx`. */
export function mintInviteCode(): string {
  const letter = () => ALPHABET.charAt(randomInt(ALPHABET.length));
  const group = () => Array.from({ length: GROUP_LENGTH }, letter).join("");
  return Array.from({ length: GROUPS }, group).join("-");
}

/** Case, spaces and dashes don't count: `ABCD EFGH…` and `abcd-efgh-…` are the same code. */
export function normalizeInviteCode(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** What the database holds for a code. */
export function hashInviteCode(code: string): string {
  return createHash("sha256").update(normalizeInviteCode(code)).digest("hex");
}

/** Whether a typed code is the one the hash was made from. */
export function inviteCodeMatches(code: string, hash: string): boolean {
  const typed = Buffer.from(hashInviteCode(code), "hex");
  const kept = Buffer.from(hash, "hex");
  return typed.length === kept.length && timingSafeEqual(typed, kept);
}
