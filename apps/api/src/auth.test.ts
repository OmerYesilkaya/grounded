import { allowlist, eq, users } from "@grounded/db";
import { describe, expect, it } from "vitest";
import { invite, revoke } from "./allowlist.js";
import { SESSION_COOKIE, SESSION_COOKIE_MAX_AGE_SECONDS } from "./auth.js";
import { createTestHarness } from "./test/harness.js";

const t = createTestHarness();

const signInRequest = (email: string, code: string) =>
  t.request("/api/auth/sign-in", { method: "POST", body: JSON.stringify({ email, code }) });

const sessionCookie = (response: Response) =>
  response.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));

const refused = async (response: Response) => {
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: { code: "email-or-code-wrong" } });
  expect(sessionCookie(response)).toBeUndefined();
};

describe("sign-in by email and invite code", () => {
  it("signs an invited email in with its code, creating them the first time and never again", async () => {
    const code = await invite(t.db, "ada@example.com");
    const first = await signInRequest("ada@example.com", code);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ email: "ada@example.com" });

    const again = await signInRequest("ada@example.com", code);
    const cookie = sessionCookie(again)?.split(";")[0] ?? "";
    const me = await t.request("/api/me", { cookie });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: "ada@example.com" });
    expect(await t.db.select().from(users).where(eq(users.email, "ada@example.com"))).toHaveLength(
      1,
    );
  });

  it("takes the code however it is typed", async () => {
    const code = await invite(t.db, "ada@example.com");
    const typed = ` ${code.toUpperCase().replaceAll("-", " ")} `;
    expect((await signInRequest("ada@example.com", typed)).status).toBe(200);
  });

  it("refuses an uninvited email, a wrong code, and another person's code, all the same way", async () => {
    const adaCode = await invite(t.db, "ada@example.com");
    await refused(await signInRequest("eve@example.com", adaCode));
    await refused(await signInRequest("ada@example.com", "abcd-efgh-jkmn-pqrs"));
    await invite(t.db, "bo@example.com");
    await refused(await signInRequest("bo@example.com", adaCode));
    expect(await t.db.select().from(users).where(eq(users.email, "eve@example.com"))).toEqual([]);
  });

  it("asks for both when either is missing", async () => {
    for (const body of [
      "{}",
      JSON.stringify({ email: "ada@example.com" }),
      JSON.stringify({ code: "x" }),
    ]) {
      const res = await t.request("/api/auth/sign-in", { method: "POST", body });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: { code: "enter-email-and-code" } });
    }
  });

  it("refuses requests without a cookie, with a forged one, and with one naming nobody", async () => {
    expect((await t.request("/api/me")).status).toBe(401);
    const cookie = await t.signIn("ada@example.com");
    const [userId = "", signature = ""] = cookie.replace(`${SESSION_COOKIE}=`, "").split(".");
    const forged = `${SESSION_COOKIE}=${userId.replace(/^./, (c) => (c === "0" ? "1" : "0"))}.${signature}`;
    expect((await t.request("/api/me", { cookie: forged })).status).toBe(401);
    expect((await t.request("/api/me", { cookie: `${SESSION_COOKIE}=${userId}` })).status).toBe(
      401,
    );
    // The row the cookie names is gone (a deleted learner keeps no access).
    await t.db.delete(users).where(eq(users.id, userId));
    expect((await t.request("/api/me", { cookie })).status).toBe(401);
  });

  it("keeps the cookie for the browser's longest allowed while, renewed by every page load", async () => {
    const code = await invite(t.db, "ada@example.com");
    const signedIn = await signInRequest("ada@example.com", code);
    const set = sessionCookie(signedIn) ?? "";
    expect(set).toContain(`Max-Age=${String(SESSION_COOKIE_MAX_AGE_SECONDS)}`);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Lax");
    expect(set).toContain("Path=/");

    const cookie = set.split(";")[0] ?? "";
    const me = await t.request("/api/me", { cookie });
    expect(sessionCookie(me)).toBe(set);
    expect(sessionCookie(await t.request("/api/credentials", { cookie }))).toBeUndefined();
  });

  it("signs out by clearing the cookie", async () => {
    const code = await invite(t.db, "ada@example.com");
    const cookie = sessionCookie(await signInRequest("ada@example.com", code))?.split(";")[0] ?? "";
    const out = await t.request("/api/auth/sign-out", { method: "POST", cookie });
    expect(out.status).toBe(204);
    expect(sessionCookie(out)).toContain("Max-Age=0");
    // The cookie itself is stateless: only the browser forgets it. Signing in again is the same code.
    expect((await signInRequest("ada@example.com", code)).status).toBe(200);
  });
});

describe("invite and revoke", () => {
  it("stores emails trimmed and lowercased, and only the code's hash", async () => {
    const code = await invite(t.db, "  Ada@Example.COM ");
    const rows = await t.db.select().from(allowlist);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe("ada@example.com");
    expect(rows[0]?.codeHash).not.toContain(code.replaceAll("-", ""));
    expect(rows[0]?.codeIssuedAt).toBeInstanceOf(Date);
    const me = await signInRequest(" ADA@example.com ", code);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: "ada@example.com" });
  });

  it("inviting again replaces the code: the new one works, the old one stops", async () => {
    const old = await invite(t.db, "ada@example.com");
    const cookie = sessionCookie(await signInRequest("ada@example.com", old))?.split(";")[0] ?? "";
    const fresh = await invite(t.db, "ada@example.com");
    expect(fresh).not.toBe(old);
    await refused(await signInRequest("ada@example.com", old));
    expect((await signInRequest("ada@example.com", fresh)).status).toBe(200);
    // Whoever is signed in stays signed in: the code guards signing in, not the session.
    expect((await t.request("/api/me", { cookie })).status).toBe(200);
  });

  it("a row without a code keeps the signed-in person in but lets nobody sign in", async () => {
    const code = await invite(t.db, "ada@example.com");
    const cookie = sessionCookie(await signInRequest("ada@example.com", code))?.split(";")[0] ?? "";
    await t.db
      .update(allowlist)
      .set({ codeHash: null, codeIssuedAt: null })
      .where(eq(allowlist.email, "ada@example.com"));
    expect((await t.request("/api/me", { cookie })).status).toBe(200);
    await refused(await signInRequest("ada@example.com", code));
    await refused(await signInRequest("ada@example.com", "abcd-efgh-jkmn-pqrs"));
  });

  it("revoking shuts the person out at once, cookie or not", async () => {
    const code = await invite(t.db, "ada@example.com");
    const cookie = sessionCookie(await signInRequest("ada@example.com", code))?.split(";")[0] ?? "";
    await revoke(t.db, "Ada@example.com");

    expect((await t.request("/api/me", { cookie })).status).toBe(401);
    await refused(await signInRequest("ada@example.com", code));

    // Inviting again lets them back in, as the same learner, with a new code.
    const fresh = await invite(t.db, "ada@example.com");
    expect((await t.request("/api/me", { cookie })).status).toBe(200);
    const back = await signInRequest("ada@example.com", fresh);
    expect(await back.json()).toMatchObject({
      id: cookie.replace(`${SESSION_COOKIE}=`, "").split(".")[0],
    });
  });
});

describe("the health check", () => {
  it("answers without a session once the database is reachable", async () => {
    const res = await t.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
