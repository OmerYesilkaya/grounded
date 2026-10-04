import { credentials } from "@grounded/db";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "./test/harness.js";

const t = createTestHarness();
const KEY = "sk-test-0123456789abcdef3456";

async function signedIn() {
  return t.signIn("ada@example.com");
}

const put = (cookie: string, body: unknown) =>
  t.request("/api/credentials", { method: "PUT", cookie, body: JSON.stringify(body) });

describe("API key credentials", () => {
  it("validates, seals and stores a key, and only ever returns its hint", async () => {
    const cookie = await signedIn();
    const response = await put(cookie, { provider: "openai", model: "gpt-6-luna", apiKey: KEY });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text)).toEqual({
      provider: "openai",
      model: "gpt-6-luna",
      keyHint: "3456",
      source: "own_key",
    });

    const [row] = await t.db.select().from(credentials);
    if (!row) throw new Error("expected a stored credential");
    expect(JSON.stringify(row)).not.toContain(KEY);
    expect(t.vault.open(row.sealedKey, row.userId)).toBe(KEY);

    const got = await t.request("/api/credentials", { cookie });
    expect(await got.json()).toEqual({
      provider: "openai",
      model: "gpt-6-luna",
      keyHint: "3456",
      source: "own_key",
    });
  });

  it("replaces the key when saved again", async () => {
    const cookie = await signedIn();
    await put(cookie, { provider: "openai", model: "gpt-6-luna", apiKey: KEY });
    await put(cookie, {
      provider: "anthropic",
      model: "claude-opus-5-5",
      apiKey: "sk-ant-zzzz9999",
    });
    const rows = await t.db.select().from(credentials);
    expect(rows.map((r) => [r.provider, r.keyHint])).toEqual([["anthropic", "9999"]]);
  });

  it("stores nothing when the provider rejects the key, and says why", async () => {
    const cookie = await signedIn();
    t.setKeyCheck({ ok: false, kind: "invalid-key", provider: "OpenAI" });
    const response = await put(cookie, { provider: "openai", model: "gpt-6-luna", apiKey: KEY });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: { code: "provider-failed", kind: "invalid-key", provider: "OpenAI" },
      kind: "invalid-key",
    });
    expect(await t.db.select().from(credentials)).toEqual([]);
  });

  it("only accepts a model offered for the provider", async () => {
    const cookie = await signedIn();
    const response = await put(cookie, {
      provider: "openai",
      model: "claude-opus-5-5",
      apiKey: KEY,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "model-unavailable" },
    });
  });

  it("deletes the key", async () => {
    const cookie = await signedIn();
    await put(cookie, { provider: "openai", model: "gpt-6-luna", apiKey: KEY });
    expect((await t.request("/api/credentials", { method: "DELETE", cookie })).status).toBe(204);
    expect(await (await t.request("/api/credentials", { cookie })).json()).toBeNull();
  });

  it("lists the models on offer for each provider", async () => {
    const cookie = await signedIn();
    const models = (await (await t.request("/api/models", { cookie })).json()) as Record<
      string,
      { id: string }[]
    >;
    expect(models.openai?.map((m) => m.id)).toEqual(["gpt-6.1-sol", "gpt-6-luna"]);
    expect(models.anthropic?.map((m) => m.id)).toContain("claude-opus-5-5");
  });

  it("refuses all of it without a session", async () => {
    expect((await t.request("/api/credentials")).status).toBe(401);
    expect((await put("", { provider: "openai", model: "gpt-6-luna", apiKey: KEY })).status).toBe(
      401,
    );
    expect((await t.request("/api/credentials", { method: "DELETE" })).status).toBe(401);
    expect((await t.request("/api/models")).status).toBe(401);
  });
});
