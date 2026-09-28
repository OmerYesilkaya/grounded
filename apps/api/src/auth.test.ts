import { eq, users } from "@grounded/db";
import { describe, expect, it } from "vitest";
import { invite, revoke } from "./allowlist.js";
import { createTestHarness } from "./test/harness.js";

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

describe("the health check", () => {
  it("answers without a session once the database is reachable", async () => {
    const res = await t.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
