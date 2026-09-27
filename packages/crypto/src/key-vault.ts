import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * An envelope-encrypted secret. A fresh data key encrypts the plaintext (AES-256-GCM); a master key
 * wraps the data key (AES-256-GCM). All fields are base64; `wrappedKey` holds its own iv and tag.
 */
export interface SealedSecret {
  v: 1;
  /** Which master key wrapped the data key. */
  kid: string;
  wrappedKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface KeyVault {
  /** `context` (the owner's id) is bound in, so a sealed secret only opens for the same owner. */
  seal(plaintext: string, context: string): SealedSecret;
  open(sealed: SealedSecret, context: string): string;
  /** Whether the secret is wrapped by the active master key. */
  isCurrent(sealed: SealedSecret): boolean;
  /** Re-wraps with the active master key (rotation). */
  reseal(sealed: SealedSecret, context: string): SealedSecret;
}

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function createKeyVault(config: {
  masterKeys: Record<string, Buffer>;
  activeKid: string;
}): KeyVault {
  for (const [kid, key] of Object.entries(config.masterKeys)) {
    if (key.length !== 32) throw new Error(`Master key "${kid}" must be 32 bytes.`);
  }
  const masterKey = (kid: string): Buffer => {
    const key = config.masterKeys[kid];
    if (!key) throw new Error(`No master key "${kid}" is configured.`);
    return key;
  };
  masterKey(config.activeKid);

  const vault: KeyVault = {
    seal(plaintext, context) {
      const dataKey = randomBytes(32);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, dataKey, iv).setAAD(Buffer.from(context));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return {
        v: 1,
        kid: config.activeKid,
        wrappedKey: wrap(dataKey, masterKey(config.activeKid), config.activeKid).toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
    },
    open(sealed, context) {
      const key = masterKey(sealed.kid);
      try {
        const dataKey = unwrap(Buffer.from(sealed.wrappedKey, "base64"), key, sealed.kid);
        const decipher = createDecipheriv(ALGORITHM, dataKey, Buffer.from(sealed.iv, "base64"))
          .setAAD(Buffer.from(context))
          .setAuthTag(Buffer.from(sealed.tag, "base64"));
        return Buffer.concat([
          decipher.update(Buffer.from(sealed.ciphertext, "base64")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        // Wrong context, a wrong key or tampering: never say which.
        throw new Error("The secret could not be opened.");
      }
    },
    isCurrent: (sealed) => sealed.kid === config.activeKid,
    reseal: (sealed, context) => vault.seal(vault.open(sealed, context), context),
  };
  return vault;
}

/** iv | tag | encrypted data key, with the kid bound in so a wrapped key can't move between masters. */
function wrap(dataKey: Buffer, master: Buffer, kid: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, master, iv).setAAD(Buffer.from(kid));
  const encrypted = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

function unwrap(wrapped: Buffer, master: Buffer, kid: string): Buffer {
  const iv = wrapped.subarray(0, IV_BYTES);
  const tag = wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, master, iv).setAAD(Buffer.from(kid)).setAuthTag(tag);
  return Buffer.concat([decipher.update(wrapped.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
}

/** Reads `KEY_VAULT_MASTER_KEYS`: "kid:base64" entries separated by commas. */
export function parseMasterKeys(value: string): Record<string, Buffer> {
  const keys: Record<string, Buffer> = {};
  for (const entry of value
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)) {
    const separator = entry.indexOf(":");
    if (separator <= 0) throw new Error(`Master key entry "${entry}" must look like "kid:base64".`);
    keys[entry.slice(0, separator)] = Buffer.from(entry.slice(separator + 1), "base64");
  }
  return keys;
}
