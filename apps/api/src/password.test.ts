import { describe, expect, it } from "vitest";
import { DECOY_HASH, hashPassword, verifyPassword } from "./password.js";

describe("the password hash", () => {
  it("verifies the password it was made from and nothing else, salted so no two are alike", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("correct horse battery", b)).toBe(true);
    expect(await verifyPassword("correct horse batter", a)).toBe(false);
    expect(await verifyPassword("", a)).toBe(false);
  });

  it("treats the same letters typed in another Unicode form as the same password", async () => {
    const hash = await hashPassword("café au lait!");
    expect(await verifyPassword("café au lait!", hash)).toBe(true);
  });

  it("refuses a hash it can't read rather than throwing", async () => {
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
    expect(await verifyPassword("anything", "bcrypt$1$2$3$4$5")).toBe(false);
  });

  it("has a decoy to spend time on that is nobody's password", async () => {
    expect(await verifyPassword("", DECOY_HASH)).toBe(false);
  });
});
