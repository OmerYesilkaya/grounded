import { eq, users } from "@grounded/db";
import { describe, expect, it } from "vitest";
import { invite, revoke } from "./allowlist.js";
import { SESSION_COOKIE, SESSION_COOKIE_MAX_AGE_SECONDS } from "./auth.js";
import { createTestHarness } from "./test/harness.js";

const t = createTestHarness();

const signInRequest = (email: string) =>
  t.request("/api/auth/sign-in", { method: "POST", body: JSON.stringify({ email }) });

const sessionCookie = (response: Response) =>
  response.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));

describe("sign-in by email", () => {
  it("signs an invited email in by entering it, creating them the first time and never again", async () => {
    await invite(t.db, "ada@example.com");
    const first = await signInRequest("ada@example.com");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ email: "ada@example.com" });

    const cookie = await t.signIn("ada@example.com");
    const me = await t.request("/api/me", { cookie });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: "ada@example.com" });
    expect(await t.db.select().from(users).where(eq(users.email, "ada@example.com"))).toHaveLength(
      1,
    );
  });

  it("refuses an uninvited email, saying so, and creates no one", async () => {
    const stranger = await signInRequest("eve@example.com");
    expect(stranger.status).toBe(403);
    expect(await stranger.json()).toEqual({ error: { code: "not-invited" } });
    expect(sessionCookie(stranger)).toBeUndefined();
    expect(await t.db.select().from(users).where(eq(users.email, "eve@example.com"))).toEqual([]);
  });

  it("asks for an email when none was sent", async () => {
    const empty = await t.request("/api/auth/sign-in", { method: "POST", body: "{}" });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: { code: "enter-email" } });
  });

  it("refuses requests without a cookie, with a forged one, and with one naming nobody", async () => {
    expect((await t.request("/api/me")).status).toBe(401);
    await invite(t.db, "ada@example.com");
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
    await invite(t.db, "ada@example.com");
    const signedIn = await signInRequest("ada@example.com");
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
    await invite(t.db, "ada@example.com");
    const cookie = await t.signIn("ada@example.com");
    const out = await t.request("/api/auth/sign-out", { method: "POST", cookie });
    expect(out.status).toBe(204);
    expect(sessionCookie(out)).toContain("Max-Age=0");
    // The cookie itself is stateless: only the browser forgets it. Signing in again is typing the email.
    expect((await t.signIn("ada@example.com")).length).toBeGreaterThan(0);
  });
});

describe("invite and revoke", () => {
  it("stores emails trimmed and lowercased, and inviting twice is harmless", async () => {
    await invite(t.db, "  Ada@Example.COM ");
    await invite(t.db, "ada@example.com");
    const cookie = await t.signIn(" ADA@example.com ");
    const me = await t.request("/api/me", { cookie });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: "ada@example.com" });
  });

  it("revoking shuts the person out at once, cookie or not", async () => {
    await invite(t.db, "ada@example.com");
    const cookie = await t.signIn("ada@example.com");
    await revoke(t.db, "Ada@example.com");

    expect((await t.request("/api/me", { cookie })).status).toBe(401);
    expect((await signInRequest("ada@example.com")).status).toBe(403);

    // Inviting again lets them back in, as the same learner.
    await invite(t.db, "ada@example.com");
    expect((await t.request("/api/me", { cookie })).status).toBe(200);
  });
});

describe("the health check", () => {
  it("answers without a session once the database is reachable", async () => {
    const res = await t.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
