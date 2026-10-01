import { eq, importedLessons, tracks, users } from "@grounded/db";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "./test/harness.js";

const t = createTestHarness();

const HTML = "<!doctype html><title>SQL</title><script>alert(1)</script><p>Joins.</p>";

async function signedIn(email: string) {
  const cookie = await t.signIn(email);
  const [user] = await t.db.select().from(users).where(eq(users.email, email));
  if (!user) throw new Error("no user");
  return { cookie, userId: user.id };
}

async function trackWithImportedLesson(userId: string) {
  const [track] = await t.db
    .insert(tracks)
    .values({ userId, title: "How software works", goal: "How software works" })
    .returning();
  if (!track) throw new Error("no track");
  await t.db
    .insert(importedLessons)
    .values({ trackId: track.id, title: "SQL", source: "2026-09-25-sql", html: HTML });
  return track.id;
}

describe("the imported last lesson", () => {
  it("is returned to its owner exactly as it was, and listed with the track", async () => {
    const { cookie, userId } = await signedIn("ada@example.com");
    const trackId = await trackWithImportedLesson(userId);

    const response = await t.request(`/api/tracks/${trackId}/imported-lesson`, { cookie });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ title: "SQL", source: "2026-09-25-sql", html: HTML });

    const list = (await (await t.request("/api/tracks", { cookie })).json()) as unknown[];
    expect(list).toMatchObject([{ id: trackId, importedLesson: { title: "SQL" } }]);
  });

  it("is not found for anyone else, or for a track without one", async () => {
    const owner = await signedIn("ada@example.com");
    const other = await signedIn("bob@example.com");
    const trackId = await trackWithImportedLesson(owner.userId);

    const response = await t.request(`/api/tracks/${trackId}/imported-lesson`, {
      cookie: other.cookie,
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Joins");

    const [plain] = await t.db
      .insert(tracks)
      .values({ userId: owner.userId, title: "Other", goal: "Other" })
      .returning();
    const none = await t.request(`/api/tracks/${plain?.id ?? ""}/imported-lesson`, {
      cookie: owner.cookie,
    });
    expect(none.status).toBe(404);
    expect((await t.request(`/api/tracks/${trackId}/imported-lesson`)).status).toBe(401);
  });
});
