import { initialSession } from "@grounded/core";
import { eq, learningSessions, tracks, users } from "@grounded/db";
import type { JobHelpers, Task } from "graphile-worker";
import { describe, expect, it, vi } from "vitest";
import { invite } from "../allowlist.js";
import { createTestHarness } from "../test/harness.js";
import { endingWhenGone } from "./gone.js";

const t = createTestHarness();
const helpers = {} as JobHelpers;

const aSession = async () => {
  await invite(t.db, "ada@example.com");
  await t.signIn("ada@example.com");
  const [user] = await t.db.select().from(users);
  const [track] = await t.db
    .insert(tracks)
    .values({ userId: user?.id ?? "", title: "SQL", goal: "SQL" })
    .returning();
  const [session] = await t.db
    .insert(learningSessions)
    .values({ trackId: track?.id ?? "", userId: user?.id ?? "", state: initialSession() })
    .returning();
  const trackId = track?.id ?? "";
  return {
    trackId,
    sessionId: session?.id ?? "",
    deleteTrack: () => t.db.delete(tracks).where(eq(tracks.id, trackId)),
  };
};

const wrap = (task: Task) => endingWhenGone({ task }, t.db).task as Task;

describe("a job on a deleted track", () => {
  it("doesn't start once its track is gone", async () => {
    const { sessionId, trackId, deleteTrack } = await aSession();
    const task = vi.fn();
    await deleteTrack();
    await wrap(task)({ sessionId }, helpers);
    await wrap(task)({ trackId }, helpers);
    expect(task).not.toHaveBeenCalled();
  });

  it("ends quietly when its track goes while it runs", async () => {
    const { sessionId, deleteTrack } = await aSession();
    const task = vi.fn(async () => {
      await deleteTrack();
      throw new Error("insert or update violates foreign key constraint");
    });
    await expect(wrap(task)({ sessionId }, helpers)).resolves.toBeUndefined();
  });

  it("still fails for any other reason", async () => {
    const { sessionId } = await aSession();
    const task = vi.fn(() => Promise.reject(new Error("provider down")));
    await expect(wrap(task)({ sessionId }, helpers)).rejects.toThrow("provider down");
  });
});
