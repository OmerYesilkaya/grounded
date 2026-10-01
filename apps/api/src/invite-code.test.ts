import { describe, expect, it } from "vitest";
import {
  hashInviteCode,
  inviteCodeMatches,
  mintInviteCode,
  normalizeInviteCode,
} from "./invite-code.js";

describe("the invite code", () => {
  it("is four groups of four from an alphabet without look-alikes, and never the same twice", () => {
    const codes = Array.from({ length: 50 }, mintInviteCode);
    for (const code of codes)
      expect(code).toMatch(/^[a-hj-km-np-z2-9]{4}(-[a-hj-km-np-z2-9]{4}){3}$/);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("matches however it was typed: case, spaces and dashes don't count", () => {
    const hash = hashInviteCode("abcd-efgh-jkmn-pqrs");
    expect(inviteCodeMatches("ABCD EFGH JKMN PQRS", hash)).toBe(true);
    expect(inviteCodeMatches("abcdefghjkmnpqrs", hash)).toBe(true);
    expect(inviteCodeMatches(" abcd-efgh-jkmn-pqrs ", hash)).toBe(true);
    expect(normalizeInviteCode("AB-cd 12")).toBe("abcd12");
  });

  it("refuses another code, a near miss, nothing, and a hash it can't compare", () => {
    const hash = hashInviteCode("abcd-efgh-jkmn-pqrs");
    expect(inviteCodeMatches("abcd-efgh-jkmn-pqrt", hash)).toBe(false);
    expect(inviteCodeMatches("", hash)).toBe(false);
    expect(inviteCodeMatches("abcd-efgh-jkmn-pqrs", "not-a-hash")).toBe(false);
  });
});
