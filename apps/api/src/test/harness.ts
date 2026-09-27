import { randomBytes } from "node:crypto";
import { createKeyVault } from "@grounded/crypto";
import { createDb } from "@grounded/db";
import type { KeyCheck } from "@grounded/providers";
import { afterAll, beforeEach } from "vitest";
import { createApp } from "../app.js";
import { createAuth } from "../auth.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

export const BASE_URL = "http://localhost:3000";

/** The real app on the test database, with magic links captured and key validation faked. */
export function createTestHarness() {
  const { db, close } = createDb(TEST_DATABASE_URL);
  const vault = createKeyVault({ masterKeys: { t1: randomBytes(32) }, activeKid: "t1" });
  const sent: { email: string; url: string }[] = [];
  let keyCheck: KeyCheck = { ok: true };

  const auth = createAuth({
    db,
    baseURL: BASE_URL,
    secret: "test-secret-that-is-long-enough-for-better-auth",
    trustedOrigins: [BASE_URL],
    sendMagicLink: (email, url) => {
      sent.push({ email, url });
    },
  });
  const app = createApp({
    db,
    auth,
    vault,
    includeUngatedModels: true,
    validateKey: () => Promise.resolve(keyCheck),
  });

  beforeEach(async () => {
    sent.length = 0;
    keyCheck = { ok: true };
    await db.execute(
      "truncate users, sessions, accounts, verifications, allowlist, credentials, usage_events cascade",
    );
  });
  afterAll(async () => {
    await close();
  });

  const request = (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set("cookie", init.cookie);
    if (init.body) headers.set("content-type", "application/json");
    headers.set("origin", BASE_URL);
    return app.request(path.startsWith("http") ? path : `${BASE_URL}${path}`, { ...init, headers });
  };

  /** Signs an allowlisted email in through the magic link; returns the session cookie. */
  const signIn = async (email: string): Promise<string> => {
    await request("/api/auth/sign-in/magic-link", {
      method: "POST",
      body: JSON.stringify({ email, callbackURL: "/" }),
    });
    const link = sent.at(-1);
    if (!link) throw new Error(`no magic link was sent to ${email}`);
    const verified = await request(link.url, { redirect: "manual" });
    return verified.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  };

  return {
    db,
    vault,
    sent,
    request,
    signIn,
    setKeyCheck: (check: KeyCheck) => {
      keyCheck = check;
    },
  };
}
