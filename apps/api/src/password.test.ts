import { describe, expect, it } from "vitest";
import { createPasswordHasher, verifyPassword } from "./password.js";

describe("the password hash", () => {
  const passwords = createPasswordHasher({ cost: 2 ** 10 });

  it("verifies the password it was made from and nothing else, salted so no two are alike", async () => {
    const a = await passwords.hash("correct horse battery");
    const b = await passwords.hash("correct horse battery");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await passwords.verify("correct horse battery", a)).toBe(true);
    expect(await passwords.verify("correct horse battery", b)).toBe(true);
    expect(await passwords.verify("correct horse batter", a)).toBe(false);
    expect(await passwords.verify("", a)).toBe(false);
  });

  it("is slow by default, and a hash verifies at whatever cost it names", async () => {
    const hash = await createPasswordHasher().hash("correct horse battery");
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await passwords.verify("correct horse battery", hash)).toBe(true);
  });

  it("treats the same letters typed in another Unicode form as the same password", async () => {
    const hash = await passwords.hash("café au lait!");
    expect(await passwords.verify("café au lait!", hash)).toBe(true);
  });

  it("refuses a hash it can't read rather than throwing", async () => {
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
    expect(await verifyPassword("anything", "bcrypt$1$2$3$4$5")).toBe(false);
  });

  it("can spend a verify's time on nobody's password", async () => {
    await expect(passwords.spendVerifyTime()).resolves.toBeUndefined();
  });
});
