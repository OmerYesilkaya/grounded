import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/*
 * The learner's password (design §4.3): chosen by a person, so low in entropy and hashed slowly
 * with scrypt (Node's own), salted per password. The stored form names its parameters, so they
 * can be raised later and old hashes still verify.
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

/** scrypt's N for a new hash: about 40 ms on a laptop core. */
export const PASSWORD_COST = 2 ** 15;
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

/** Whether the password is the one the stored hash was made from; false for a hash it can't read. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !N || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await derive(password, Buffer.from(salt, "base64"), Number(N), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export interface PasswordHasher {
  /** The stored form: `scrypt$N$r$p$salt$hash`, salt and hash base64. */
  hash(password: string): Promise<string>;
  verify(password: string, stored: string): Promise<boolean>;
  /**
   * Spends the time a verify takes, for when there is no hash to verify against: refusing an
   * unknown email then takes as long as refusing a wrong password, and the allowlist can't be
   * probed by timing.
   */
  spendVerifyTime(): Promise<void>;
}

export interface PasswordHasherOptions {
  /**
   * scrypt's N for new hashes (default `PASSWORD_COST`). The test harness lowers it: it signs in
   * hundreds of times a run, and nothing it tests depends on how slow the hash is.
   */
  cost?: number;
}

export function createPasswordHasher(options: PasswordHasherOptions = {}): PasswordHasher {
  const cost = options.cost ?? PASSWORD_COST;
  const hash = async (password: string): Promise<string> => {
    const salt = randomBytes(16);
    const key = await derive(password, salt, cost, BLOCK_SIZE, PARALLELISM);
    return [
      "scrypt",
      cost,
      BLOCK_SIZE,
      PARALLELISM,
      salt.toString("base64"),
      key.toString("base64"),
    ].join("$");
  };
  // Nobody's password, hashed at the same cost as everyone's, so verifying against it takes as long.
  const decoy = hash("a decoy, never anyone's password");
  return {
    hash,
    verify: verifyPassword,
    spendVerifyTime: async () => {
      await verifyPassword("", await decoy);
    },
  };
}
