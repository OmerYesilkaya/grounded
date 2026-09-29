import { eq, users, verifications } from "@grounded/db";
import { describe, expect, it } from "vitest";
import { invite, revoke } from "./allowlist.js";
import { createAuth } from "./auth.js";
import { createInviteLink, INVITE_LINK_LIFETIME_SECONDS } from "./invite-link.js";
import { BASE_URL, createTestHarness } from "./test/harness.js";

const t = createTestHarness();

describe("sign-in with a magic link", () => {
  it("sends a link to an invited email and signs them in with it", async () => {
    await invite(t.db, "ada@example.com");
    const cookie = await t.signIn("ada@example.com");

    expect(t.sent.map((s) => s.email)).toEqual(["ada@example.com"]);
    const me = await t.request("/api/me", { cookie });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: "ada@example.com" });
  });

  it("answers an uninvited email exactly the same, but sends nothing and creates no one", async () => {
    await invite(t.db, "ada@example.com");
    const body = (email: string) => JSON.stringify({ email, callbackURL: "/" });
    const invited = await t.request("/api/auth/sign-in/magic-link", {
      method: "POST",
      body: body("ada@example.com"),
    });
    const stranger = await t.request("/api/auth/sign-in/magic-link", {
      method: "POST",
      body: body("eve@example.com"),
    });

    expect(stranger.status).toBe(invited.status);
    expect(await stranger.json()).toEqual(await invited.json());
    expect(t.sent.map((s) => s.email)).toEqual(["ada@example.com"]);
    expect(await t.db.select().from(users).where(eq(users.email, "eve@example.com"))).toEqual([]);
  });

  it("refuses requests without a session", async () => {
    expect((await t.request("/api/me")).status).toBe(401);
  });
});

describe("invite and revoke", () => {
  it("stores emails trimmed and lowercased, and inviting twice is harmless", async () => {
    await invite(t.db, "  Ada@Example.COM ");
    await invite(t.db, "ada@example.com");
    const cookie = await t.signIn("ADA@example.com");
    expect((await t.request("/api/me", { cookie })).status).toBe(200);
  });

  it("revoking ends the person's sessions at once", async () => {
    await invite(t.db, "ada@example.com");
    const cookie = await t.signIn("ada@example.com");
    await revoke(t.db, "Ada@example.com");

    expect((await t.request("/api/me", { cookie })).status).toBe(401);
    await t.request("/api/auth/sign-in/magic-link", {
      method: "POST",
      body: JSON.stringify({ email: "ada@example.com", callbackURL: "/" }),
    });
    expect(t.sent).toHaveLength(1);
  });
});

describe("an invite link", () => {
  const mint = (email: string) =>
    createInviteLink({
      db: t.db,
      email,
      appUrl: BASE_URL,
      secret: "test-secret-that-is-long-enough-for-better-auth",
    });

  it("invites the email and signs them in once, without sending anything", async () => {
    const link = await mint(" Ada@Example.com ");
    expect(t.sent).toEqual([]);
    expect(link.startsWith(`${BASE_URL}/api/auth/magic-link/verify?token=`)).toBe(true);

    const first = await t.request(link, { redirect: "manual" });
    const cookie = first.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const me = await t.request("/api/me", { cookie });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: "ada@example.com" });

    const again = await t.request(link, { redirect: "manual" });
    expect(again.headers.get("location")).toContain("error=INVALID_TOKEN");
  });

  it("stays valid for a week, not the five minutes of an emailed link", async () => {
    const before = Date.now();
    await mint("ada@example.com");
    const [row] = await t.db.select().from(verifications);
    const lifetime = (row?.expiresAt.getTime() ?? 0) - before;
    expect(lifetime).toBeGreaterThan((INVITE_LINK_LIFETIME_SECONDS - 60) * 1000);
    expect(lifetime).toBeLessThanOrEqual(INVITE_LINK_LIFETIME_SECONDS * 1000 + 60_000);
  });
});

describe("the health check", () => {
  it("answers without a session once the database is reachable", async () => {
    const res = await t.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

describe("rate limiting behind the host's proxy", () => {
  const auth = createAuth({
    db: t.db,
    baseURL: BASE_URL,
    secret: "test-secret-that-is-long-enough-for-better-auth",
    trustedOrigins: [BASE_URL],
    sendMagicLink: () => undefined,
    trustedProxies: ["100.0.0.0/8"],
    rateLimit: true,
  });
  // What the proxy sends: anything the client claimed, then the client, then the proxy's own hop.
  const askForLink = (forwardedFor: string) =>
    auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/magic-link`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE_URL,
          "x-forwarded-for": forwardedFor,
        },
        body: JSON.stringify({ email: "ada@example.com", callbackURL: "/" }),
      }),
    );

  it("limits each client by its own address, whatever it claims to be", async () => {
    // The magic-link rule allows 5 a minute.
    for (let i = 0; i < 5; i++) {
      expect((await askForLink(`9.9.9.${String(i)}, 203.0.113.7, 100.64.0.2`)).status).toBe(200);
    }
    expect((await askForLink("203.0.113.7, 100.64.0.3")).status).toBe(429);
    expect((await askForLink("198.51.100.4, 100.64.0.2")).status).toBe(200);
  });
});
