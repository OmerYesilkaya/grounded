import { initialSession } from "@grounded/core";
import { learningSessions, tracks, usageEvents, users, eq } from "@grounded/db";
import { describe, expect, it } from "vitest";
import { invite } from "./allowlist.js";
import type { UsageReport } from "./routes/usage.js";
import { createTestHarness } from "./test/harness.js";

const t = createTestHarness();

/** A cost to a hundredth of a cent, for comparing sums of floats. */
const cents = (usd: number | null) => (usd === null ? null : Math.round(usd * 1e4) / 1e4);

const call = (
  userId: string,
  at: string,
  extra: Partial<typeof usageEvents.$inferInsert> = {},
): typeof usageEvents.$inferInsert => ({
  userId,
  provider: "anthropic",
  model: "claude-opus-5-5",
  purpose: "lesson",
  inputTokens: 1_000_000,
  cachedInputTokens: 0,
  outputTokens: 100_000,
  createdAt: new Date(at),
  ...extra,
});

describe("usage", () => {
  it("adds up each month and each session, costed at the model list's prices", async () => {
    await invite(t.db, "ada@example.com");
    const cookie = await t.signIn("ada@example.com");
    const [user] = await t.db.select().from(users).where(eq(users.email, "ada@example.com"));
    const userId = user?.id ?? "";
    const [track] = await t.db
      .insert(tracks)
      .values({ userId, title: "How software works", goal: "How software works" })
      .returning();
    const trackId = track?.id ?? "";
    const [first, second] = await t.db
      .insert(learningSessions)
      .values([
        {
          trackId,
          userId,
          state: initialSession(),
          createdAt: new Date("2026-08-30T08:00:00Z"),
          closedAt: new Date("2026-08-30T10:00:00Z"),
        },
        { trackId, userId, state: initialSession(), createdAt: new Date("2026-09-02T10:00:00Z") },
      ])
      .returning();
    await t.db.insert(usageEvents).values([
      // $4 + $2 at Opus's prices, in August.
      call(userId, "2026-08-30T09:00:00Z", { trackId, sessionId: first?.id ?? null }),
      // Half the input read from the cache and a model with no price, in September.
      call(userId, "2026-09-02T11:00:00Z", {
        trackId,
        sessionId: second?.id ?? null,
        cachedInputTokens: 500_000,
      }),
      call(userId, "2026-09-02T11:30:00Z", {
        trackId,
        sessionId: second?.id ?? null,
        provider: "openai",
        model: "gpt-6-luna",
      }),
      // Naming the track: no session. Late on 30 September in UTC, 1 October in Istanbul.
      call(userId, "2026-09-30T22:30:00Z", {
        trackId,
        purpose: "track-name",
        model: "claude-haiku-4-5-20251001",
        inputTokens: 1000,
        outputTokens: 0,
      }),
    ]);

    const report = (await (
      await t.request("/api/usage?tz=Europe/Istanbul", { cookie })
    ).json()) as UsageReport;

    expect(report.months.map((m) => [m.month, m.calls, cents(m.costUsd), m.unpriced])).toEqual([
      ["2026-10", 1, 0.001, 0],
      ["2026-09", 2, 4.1, 1],
      ["2026-08", 1, 6, 0],
    ]);
    expect(
      report.sessions.map((s) => [
        s.number,
        s.trackTitle,
        s.calls,
        cents(s.costUsd),
        s.inputTokens,
      ]),
    ).toEqual([
      [2, "How software works", 2, 4.1, 2_000_000],
      [1, "How software works", 1, 6, 1_000_000],
    ]);

    const utc = (await (
      await t.request("/api/usage?tz=Mars/Olympus", { cookie })
    ).json()) as UsageReport;
    expect(utc.months.map((m) => m.month)).toEqual(["2026-09", "2026-08"]);
  });

  it("shows a learner only their own calls", async () => {
    await invite(t.db, "eve@example.com");
    const cookie = await t.signIn("eve@example.com");
    const [other] = await t.db
      .insert(users)
      .values({ name: "Ada", email: "ada@example.com" })
      .returning();
    await t.db.insert(usageEvents).values(call(other?.id ?? "", "2026-09-02T11:00:00Z"));

    const report = (await (await t.request("/api/usage", { cookie })).json()) as UsageReport;
    expect(report).toEqual({ months: [], sessions: [] });
  });
});
