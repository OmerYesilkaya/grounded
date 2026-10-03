import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import { serveAdmin, serveWeb } from "./web.js";

const root = mkdtempSync(join(tmpdir(), "grounded-web-"));
mkdirSync(join(root, "assets"));
writeFileSync(join(root, "index.html"), "<!doctype html><title>Grounded</title>");
writeFileSync(join(root, "assets", "index-abc123.js"), "console.log(1)");
writeFileSync(join(root, "favicon.svg"), "<svg/>");
const adminRoot = mkdtempSync(join(tmpdir(), "grounded-admin-"));
mkdirSync(join(adminRoot, "assets"));
writeFileSync(join(adminRoot, "index.html"), "<!doctype html><title>Grounded admin</title>");
writeFileSync(join(adminRoot, "assets", "index-def456.js"), "console.log(2)");
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(adminRoot, { recursive: true, force: true });
});

const app = new Hono();
app.get("/api/me", (c) => c.json({ ok: true }));
serveAdmin(app, adminRoot);
serveWeb(app, root);

describe("serving the web app", () => {
  it("serves fingerprinted assets, cached for good", async () => {
    const res = await app.request("/assets/index-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("answers a missing asset with a 404, not the app", async () => {
    expect((await app.request("/assets/index-old.js")).status).toBe(404);
  });

  it("serves other files uncached", async () => {
    const res = await app.request("/favicon.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("answers the root and client routes with index.html, uncached", async () => {
    for (const path of ["/", "/tracks/0199-abc/sessions/0199-def"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>Grounded</title>");
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
  });

  it("leaves /api to the API", async () => {
    expect(await (await app.request("/api/me")).json()).toEqual({ ok: true });
    expect((await app.request("/api/nothing-here")).status).toBe(404);
    expect((await app.request("/api")).status).toBe(404);
  });
});

describe("serving the admin panel", () => {
  it("serves its assets under /admin, cached for good", async () => {
    const res = await app.request("/admin/assets/index-def456.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await app.request("/admin/assets/index-abc123.js")).status).toBe(404);
  });

  it("answers its client routes with its own index.html, and /admin with a redirect to it", async () => {
    for (const path of ["/admin/", "/admin/sessions/0199-def"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>Grounded admin</title>");
    }
    const bare = await app.request("/admin");
    expect(bare.status).toBe(302);
    expect(bare.headers.get("location")).toBe("/admin/");
  });

  it("leaves the web app where it was", async () => {
    expect(await (await app.request("/sessions")).text()).toContain("<title>Grounded</title>");
  });
});
