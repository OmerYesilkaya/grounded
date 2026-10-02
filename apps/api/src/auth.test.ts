import { allowlist, eq, users } from "@grounded/db";
import { describe, expect, it } from "vitest";
import { invite, revoke } from "./allowlist.js";
import {
  LOCK_MINUTES,
  MAX_SIGN_IN_FAILURES,
  SESSION_COOKIE,
  SESSION_COOKIE_MAX_AGE_SECONDS,
} from "./auth.js";
import { createTestHarness } from "./test/harness.js";

const t = createTestHarness();

const signInRequest = (email: string, password: string) =>
  t.request("/api/auth/sign-in", { method: "POST", body: JSON.stringify({ email, password }) });

const sessionCookie = (response: Response) =>
  response.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));

const cookieOf = (response: Response) => sessionCookie(response)?.split(";")[0] ?? "";

const refused = async (response: Response) => {
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: { code: "email-or-password-wrong" } });
  expect(sessionCookie(response)).toBeUndefined();
};

const setPasswordRequest = (cookie: string, body: Record<string, unknown>) =>
  t.request("/api/auth/password", { method: "PUT", cookie, body: JSON.stringify(body) });

/** Invites, signs in with the code and chooses the password: a first visit; the session cookie. */
async function firstVisit(email: string, password: string) {
  const code = await invite(t.db, email);
  const cookie = cookieOf(await signInRequest(email, code));
  expect((await setPasswordRequest(cookie, { password })).status).toBe(200);
  return cookie;
}

describe("the first sign-in, with the invite code", () => {
  it("signs an invited email in with its code, creating them the first time and never again", async () => {
    const code = await invite(t.db, "ada@example.com");
    const first = await signInRequest("ada@example.com", code);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ email: "ada@example.com", passwordSet: false });

    const me = await t.request("/api/me", {
      cookie: cookieOf(await signInRequest("ada@example.com", code)),
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: "ada@example.com", passwordSet: false });
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
      JSON.stringify({ password: "x" }),
    ]) {
      const res = await t.request("/api/auth/sign-in", { method: "POST", body });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: { code: "enter-email-and-password" } });
    }
  });
});

describe("choosing the password", () => {
  it("ends the invite code; from then on sign-in is the password", async () => {
    const code = await invite(t.db, "ada@example.com");
    const cookie = cookieOf(await signInRequest("ada@example.com", code));
    const set = await setPasswordRequest(cookie, { password: "a long enough password" });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ email: "ada@example.com", passwordSet: true });
    expect(await (await t.request("/api/me", { cookie })).json()).toMatchObject({
      passwordSet: true,
    });

    await refused(await signInRequest("ada@example.com", code));
    const back = await signInRequest("ada@example.com", "a long enough password");
    expect(back.status).toBe(200);
    expect(await back.json()).toMatchObject({ email: "ada@example.com", passwordSet: true });
    await refused(await signInRequest("ada@example.com", "a long enough passwor"));
    await refused(await signInRequest("eve@example.com", "a long enough password"));

    const [row] = await t.db.select().from(allowlist);
    expect(row?.codeHash).toBeNull();
    const [user] = await t.db.select().from(users);
    expect(user?.passwordHash).not.toContain("a long enough password");
    expect(user?.passwordSetAt).toBeInstanceOf(Date);
  });

  it("wants 10 to 200 characters", async () => {
    const code = await invite(t.db, "ada@example.com");
    const cookie = cookieOf(await signInRequest("ada@example.com", code));
    for (const body of [{}, { password: "short one" }, { password: "x".repeat(201) }]) {
      const res = await setPasswordRequest(cookie, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: { code: "password-length", min: 10, max: 200 } });
    }
    expect((await setPasswordRequest(cookie, { password: "x".repeat(200) })).status).toBe(200);
  });

  it("is changed by giving the current one, and the current one only", async () => {
    const cookie = await firstVisit("ada@example.com", "the first password");
    const noCurrent = await setPasswordRequest(cookie, { password: "the second password" });
    expect(noCurrent.status).toBe(403);
    expect(await noCurrent.json()).toEqual({ error: { code: "current-password-wrong" } });
    const wrong = await setPasswordRequest(cookie, {
      password: "the second password",
      current: "nope nope nope",
    });
    expect(wrong.status).toBe(403);
    const changed = await setPasswordRequest(cookie, {
      password: "the second password",
      current: "the first password",
    });
    expect(changed.status).toBe(200);
    await refused(await signInRequest("ada@example.com", "the first password"));
    expect((await signInRequest("ada@example.com", "the second password")).status).toBe(200);
  });
});

describe("wrong passwords", () => {
  it(`lock sign-in after ${String(MAX_SIGN_IN_FAILURES)} in a row, even to the right one, for ${String(LOCK_MINUTES)} minutes`, async () => {
    await firstVisit("ada@example.com", "the real password");
    for (let i = 0; i < MAX_SIGN_IN_FAILURES - 1; i++)
      await refused(await signInRequest("ada@example.com", "a wrong password"));
    // Still open: the right password gets in and the count starts over.
    expect((await signInRequest("ada@example.com", "the real password")).status).toBe(200);
    for (let i = 0; i < MAX_SIGN_IN_FAILURES; i++)
      await refused(await signInRequest("ada@example.com", "a wrong password"));

    const locked = await signInRequest("ada@example.com", "the real password");
    expect(locked.status).toBe(429);
    expect(await locked.json()).toEqual({ error: { code: "too-many-attempts" } });
    const [user] = await t.db.select().from(users);
    const lockedFor = (user?.lockedUntil?.getTime() ?? 0) - Date.now();
    expect(lockedFor).toBeGreaterThan((LOCK_MINUTES - 1) * 60_000);
    expect(lockedFor).toBeLessThanOrEqual(LOCK_MINUTES * 60_000);

    // The lock passes.
    await t.db.update(users).set({ lockedUntil: new Date(Date.now() - 1000) });
    expect((await signInRequest("ada@example.com", "the real password")).status).toBe(200);
  });

  it("count when changing the password too, so an open session can't guess it", async () => {
    const cookie = await firstVisit("ada@example.com", "the real password");
    for (let i = 0; i < MAX_SIGN_IN_FAILURES; i++)
      expect(
        (await setPasswordRequest(cookie, { password: "another password", current: "wrong" }))
          .status,
      ).toBe(403);
    expect(
      (
        await setPasswordRequest(cookie, {
          password: "another password",
          current: "the real password",
        })
      ).status,
    ).toBe(429);
    expect((await signInRequest("ada@example.com", "the real password")).status).toBe(429);
  });

  it("a wrong invite code is not counted: it can't be guessed anyway, and there may be no one to count against", async () => {
    const code = await invite(t.db, "ada@example.com");
    for (let i = 0; i <= MAX_SIGN_IN_FAILURES; i++)
      await refused(await signInRequest("ada@example.com", "abcd-efgh-jkmn-pqrs"));
    expect((await signInRequest("ada@example.com", code)).status).toBe(200);
  });
});

describe("the session", () => {
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

  it("ends at sign-out by clearing the cookie", async () => {
    const cookie = await firstVisit("ada@example.com", "the real password");
    const out = await t.request("/api/auth/sign-out", { method: "POST", cookie });
    expect(out.status).toBe(204);
    expect(sessionCookie(out)).toContain("Max-Age=0");
    // The cookie itself is stateless: only the browser forgets it. Signing in again is the password.
    expect((await signInRequest("ada@example.com", "the real password")).status).toBe(200);
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

  it("inviting again replaces the code and clears the password; whoever is signed in stays", async () => {
    const cookie = await firstVisit("ada@example.com", "a forgotten password");
    const fresh = await invite(t.db, "ada@example.com");
    await refused(await signInRequest("ada@example.com", "a forgotten password"));
    const back = await signInRequest("ada@example.com", fresh);
    expect(back.status).toBe(200);
    expect(await back.json()).toMatchObject({ passwordSet: false });
    // The code guards signing in, not the session: the open one stays, and now asks for a password.
    expect(await (await t.request("/api/me", { cookie })).json()).toMatchObject({
      passwordSet: false,
    });
  });

  it("inviting again lifts a lock and starts the count over", async () => {
    await firstVisit("ada@example.com", "the real password");
    for (let i = 0; i < MAX_SIGN_IN_FAILURES; i++)
      await refused(await signInRequest("ada@example.com", "a wrong password"));
    const fresh = await invite(t.db, "ada@example.com");
    expect((await signInRequest("ada@example.com", fresh)).status).toBe(200);
  });

  it("a row without a code keeps the signed-in person in but lets nobody sign in", async () => {
    const code = await invite(t.db, "ada@example.com");
    const cookie = cookieOf(await signInRequest("ada@example.com", code));
    await t.db
      .update(allowlist)
      .set({ codeHash: null })
      .where(eq(allowlist.email, "ada@example.com"));
    expect((await t.request("/api/me", { cookie })).status).toBe(200);
    await refused(await signInRequest("ada@example.com", code));
    await refused(await signInRequest("ada@example.com", "abcd-efgh-jkmn-pqrs"));
  });

  it("revoking shuts the person out at once, cookie or not", async () => {
    const cookie = await firstVisit("ada@example.com", "the real password");
    await revoke(t.db, "Ada@example.com");

    expect((await t.request("/api/me", { cookie })).status).toBe(401);
    await refused(await signInRequest("ada@example.com", "the real password"));

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
