import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createKeyVault, parseMasterKeys, type SealedSecret } from "./index.js";

const k1 = randomBytes(32);
const k2 = randomBytes(32);
const vault = createKeyVault({ masterKeys: { k1 }, activeKid: "k1" });

describe("key vault", () => {
  it("opens what it sealed, for the same context", () => {
    const sealed = vault.seal("sk-live-abc123", "user-1");
    expect(sealed.kid).toBe("k1");
    expect(JSON.stringify(sealed)).not.toContain("sk-live-abc123");
    expect(vault.open(sealed, "user-1")).toBe("sk-live-abc123");
  });

  it("uses a fresh data key and IV every time", () => {
    const a = vault.seal("same", "user-1");
    const b = vault.seal("same", "user-1");
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
    expect(a.iv).not.toBe(b.iv);
  });

  it("refuses a secret sealed for another context", () => {
    const sealed = vault.seal("sk-live-abc123", "user-1");
    expect(() => vault.open(sealed, "user-2")).toThrow("The secret could not be opened.");
  });

  it.each(["ciphertext", "tag", "iv", "wrappedKey"] as const)(
    "refuses a secret whose %s was altered",
    (field) => {
      const sealed = vault.seal("sk-live-abc123", "user-1");
      const bytes = Buffer.from(sealed[field], "base64");
      bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      const tampered: SealedSecret = { ...sealed, [field]: bytes.toString("base64") };
      expect(() => vault.open(tampered, "user-1")).toThrow("The secret could not be opened.");
    },
  );

  it("names an unknown master key", () => {
    const sealed = { ...vault.seal("x", "user-1"), kid: "gone" };
    expect(() => vault.open(sealed, "user-1")).toThrow('No master key "gone" is configured.');
  });

  it("rotates: old master keys still open, reseal moves to the active one", () => {
    const old = vault.seal("sk-live-abc123", "user-1");
    const rotated = createKeyVault({ masterKeys: { k1, k2 }, activeKid: "k2" });

    expect(rotated.open(old, "user-1")).toBe("sk-live-abc123");
    expect(rotated.isCurrent(old)).toBe(false);
    const resealed = rotated.reseal(old, "user-1");
    expect(resealed.kid).toBe("k2");
    expect(rotated.isCurrent(resealed)).toBe(true);
    expect(rotated.open(resealed, "user-1")).toBe("sk-live-abc123");
  });

  it("rejects a bad configuration", () => {
    expect(() => createKeyVault({ masterKeys: { k1: randomBytes(16) }, activeKid: "k1" })).toThrow(
      'Master key "k1" must be 32 bytes.',
    );
    expect(() => createKeyVault({ masterKeys: { k1 }, activeKid: "k9" })).toThrow(
      'No master key "k9" is configured.',
    );
  });
});

describe("parseMasterKeys", () => {
  it("reads 'kid:base64' pairs separated by commas", () => {
    const keys = parseMasterKeys(`k1:${k1.toString("base64")}, k2:${k2.toString("base64")}`);
    expect(Object.keys(keys)).toEqual(["k1", "k2"]);
    expect(keys.k2?.equals(k2)).toBe(true);
  });

  it("rejects malformed entries", () => {
    expect(() => parseMasterKeys("k1")).toThrow(
      'Master key entry "k1" must look like "kid:base64".',
    );
  });
});
