import {
  and,
  desc,
  eq,
  inArray,
  learningSessions,
  sql,
  tracks,
  usageEvents,
  type Db,
} from "@grounded/db";
import { estimateCost } from "@grounded/providers";
import type { Hono } from "hono";

interface Env {
  Variables: { user: { id: string; email: string } };
}

/** What a set of model calls used, and what it cost at the model list's prices (design §4.4). */
export interface UsageTotal {
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** USD, for the calls whose model has a price; null when none of them has one. */
  costUsd: number | null;
  /** Calls whose model has no price yet, left out of `costUsd`. */
  unpriced: number;
}

export interface UsageReport {
  /** Newest first, the months with any call, in the learner's time zone. */
  months: ({ month: string } & UsageTotal)[];
  /** The most recent sessions with any call, newest first. */
  sessions: ({
    id: string;
    trackId: string;
    trackTitle: string;
    /** The session's place in its track, from 1. */
    number: number;
    startedAt: string;
  } & UsageTotal)[];
}

/** How many months and sessions the page lists. */
const MONTHS = 12;
const SESSIONS = 30;

interface Row {
  model: string;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

/** Sums per-model rows into one total, costing each model at its price. */
function total(rows: readonly Row[]): UsageTotal {
  const sum: UsageTotal = {
    calls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    unpriced: 0,
  };
  for (const row of rows) {
    sum.calls += row.calls;
    sum.inputTokens += row.inputTokens;
    sum.cachedInputTokens += row.cachedInputTokens;
    sum.outputTokens += row.outputTokens;
    const cost = estimateCost(row.model, row);
    if (cost === null) sum.unpriced += row.calls;
    else sum.costUsd = (sum.costUsd ?? 0) + cost;
  }
  return sum;
}

/** A time zone Postgres and the browser both know, or UTC. */
function zoneOf(value: string | undefined): string {
  if (!value) return "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return value;
  } catch {
    return "UTC";
  }
}

const sums = {
  model: usageEvents.model,
  calls: sql<number>`count(*)::int`,
  inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::int`,
  cachedInputTokens: sql<number>`coalesce(sum(${usageEvents.cachedInputTokens}), 0)::int`,
  cacheWriteTokens: sql<number>`coalesce(sum(${usageEvents.cacheWriteTokens}), 0)::int`,
  outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::int`,
};

/** A learner's usage per month and per session (design §4.4), failed calls included. */
export async function usageReport(db: Db, userId: string, timeZone: string): Promise<UsageReport> {
  const month = sql<string>`to_char(${usageEvents.createdAt} at time zone ${timeZone}, 'YYYY-MM')`;
  const byMonth = await db
    .select({ month, ...sums })
    .from(usageEvents)
    .where(eq(usageEvents.userId, userId))
    // By position: the month's expression carries the zone as a parameter, which Postgres would
    // number differently in the grouping and not match.
    .groupBy(sql`1`, sql`2`);
  const months = [...Map.groupBy(byMonth, (r) => r.month)]
    .map(([month, rows]) => ({ month, ...total(rows) }))
    .sort((a, b) => b.month.localeCompare(a.month))
    .slice(0, MONTHS);

  const recent = await db
    .select({ id: usageEvents.sessionId, last: sql<string>`max(${usageEvents.createdAt})` })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), sql`${usageEvents.sessionId} is not null`))
    .groupBy(usageEvents.sessionId)
    .orderBy(desc(sql`max(${usageEvents.createdAt})`))
    .limit(SESSIONS);
  const ids = recent.flatMap((r) => (r.id ? [r.id] : []));
  if (ids.length === 0) return { months, sessions: [] };
  const bySession = await db
    .select({ sessionId: usageEvents.sessionId, ...sums })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), inArray(usageEvents.sessionId, ids)))
    .groupBy(usageEvents.sessionId, usageEvents.model);
  // Each session's place in its track counts every session of the track, not only these.
  const numbered = await db
    .select({
      id: learningSessions.id,
      trackId: learningSessions.trackId,
      trackTitle: tracks.title,
      createdAt: learningSessions.createdAt,
      number: sql<number>`row_number() over (partition by ${learningSessions.trackId} order by ${learningSessions.createdAt}, ${learningSessions.id})::int`,
    })
    .from(learningSessions)
    .innerJoin(tracks, eq(tracks.id, learningSessions.trackId))
    .where(eq(learningSessions.userId, userId));
  const sessionOf = new Map(numbered.map((s) => [s.id, s]));
  const sessions = ids.flatMap((id) => {
    const session = sessionOf.get(id);
    if (!session) return [];
    return [
      {
        id,
        trackId: session.trackId,
        trackTitle: session.trackTitle,
        number: session.number,
        startedAt: session.createdAt.toISOString(),
        ...total(bySession.filter((r) => r.sessionId === id)),
      },
    ];
  });
  return { months, sessions };
}

/** The usage page's data (design §4.4). `tz` is the browser's time zone, for the months. */
export function registerUsageRoutes(app: Hono<Env>, deps: { db: Db }) {
  app.get("/api/usage", async (c) =>
    c.json(await usageReport(deps.db, c.get("user").id, zoneOf(c.req.query("tz")))),
  );
}
