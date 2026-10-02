import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/*
 * The learner's password (design §4.3): chosen by a person, so low in entropy and hashed slowly
 * with scrypt (Node's own), salted per password. The stored form names its parameters, so they
 * can be raised later and old hashes still verify.
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

const COST = 2 ** 15;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 32;

const derive = (password: string, salt: Buffer, N: number, r: number, p: number) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      KEY_LENGTH,
      { N, r, p, maxmem: 256 * N * r },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });

/** The stored form: `scrypt$N$r$p$salt$hash`, salt and hash base64. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST, BLOCK_SIZE, PARALLELISM);
  return [
    "scrypt",
    COST,
    BLOCK_SIZE,
    PARALLELISM,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

/** Whether the password is the one the stored hash was made from; false for a hash it can't read. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !N || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await derive(password, Buffer.from(salt, "base64"), Number(N), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/**
 * A hash to verify against when there is no real one, so refusing an unknown email takes as long
 * as refusing a wrong password and the allowlist can't be probed by timing.
 */
export const DECOY_HASH = await hashPassword("a decoy, never anyone's password");
