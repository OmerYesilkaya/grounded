import type { ActivityNotice, FailureNotice } from "@grounded/core";
import { and, asc, eq, gt, lte, sessionEvents, sql, type Db } from "@grounded/db";
import type { Sql } from "postgres";
import { v7 as uuidv7 } from "uuid";
import { log } from "../log.js";

const CHANNEL = "session_events";

/*
 * Activity events tell the learner what a job is doing right now, for a live status line:
 *
 *   activity            { id, label: ActivityNotice, detail: string | null, state: "running" | "done" }
 *   activity-reasoning  { id, text }
 *
 * The latest `activity` event for an id is that activity's current state; a later one may change its
 * label or detail while it runs. Every activity that starts running ends with "done", whether its work
 * succeeded or not (a failure is reported by its own `error` event). Several can run at once (a web
 * search inside the research); the most recently started one still running is the one to show.
 * `activity-reasoning` appends a piece of the model's reasoning summary to a running activity, for a
 * collapsed detail; only some providers stream one, so nothing may depend on it. The session snapshot
 * lists the activities still running at its cursor, so a page opened mid-job can show them.
 */
export interface ActivityEvent {
  id: string;
  /** What the job is doing: a notice the web words (design §9.3). */
  label: ActivityNotice;
  detail: string | null;
  state: "running" | "done";
}

/** A transaction on the database, for work that must commit together with its events. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/*
 * A session's events become visible in id order. Ids come from a sequence, taken at insert, but
 * transactions commit in their own order: two publishers on one session could otherwise commit 102
 * before 101, and a stream that has delivered 102 resumes after it and never delivers 101 (nor would
 * a snapshot whose cursor is 102). So appending first takes the session's event lock, an advisory
 * lock held until the transaction ends: the session's next event gets its id only once the previous
 * one has committed. Sessions don't wait for each other.
 *
 * Lock order: a session's event lock, then its row. Appending an event takes a key-share lock on the
 * session row (the foreign key) while holding the event lock, so a transaction that locks the session
 * row takes the event lock first (applyEvent does, and appends its state event inside), and nothing
 * may wait for a publish on another connection while holding the session row.
 */
export async function lockSessionEvents(tx: Tx, sessionId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${CHANNEL}), hashtext(${sessionId}))`);
}

/** Appends an event to the session's log and wakes its open streams. Returns the event id. */
export async function publish(
  db: Db,
  sessionId: string,
  type: string,
  data: unknown,
): Promise<number> {
  return db.transaction((tx) => appendEvent(tx, sessionId, type, data));
}

/**
 * Appends an event within the caller's transaction; it becomes visible when that commits. The
 * session's event lock is held until then, so keep the rest of the transaction short.
 */
export async function appendEvent(
  tx: Tx,
  sessionId: string,
  type: string,
  data: unknown,
): Promise<number> {
  await lockSessionEvents(tx, sessionId);
  const [row] = await tx
    .insert(sessionEvents)
    .values({ sessionId, type, data })
    .returning({ id: sessionEvents.id });
  if (!row) throw new Error("event insert returned nothing");
  // Delivered when the transaction commits, so a woken stream finds the event.
  await tx.execute(sql`select pg_notify(${CHANNEL}, ${sessionId})`);
  // Its type and id only: the data is the session's content. Streamed pieces only when tracing.
  log[STREAMED.has(type) ? "trace" : "debug"](
    { sessionId, eventId: row.id, type },
    "event appended",
  );
  return row.id;
}

/** Events a stream sends many of, piece by piece. */
const STREAMED = new Set(["message-delta", "activity-reasoning"]);

export async function eventsAfter(db: Db, sessionId: string, afterId: number) {
  return db
    .select()
    .from(sessionEvents)
    .where(and(eq(sessionEvents.sessionId, sessionId), gt(sessionEvents.id, afterId)))
    .orderBy(asc(sessionEvents.id));
}

/** Batches streamed text: one event per ~80 ms or 400 characters, not one per token. */
export function batcher(flush: (text: string) => Promise<void>) {
  let pending = "";
  let last = Date.now();
  return {
    async add(delta: string) {
      pending += delta;
      if (pending.length >= 400 || Date.now() - last >= 80) {
        const text = pending;
        pending = "";
        last = Date.now();
        await flush(text);
      }
    },
    async end() {
      if (pending) await flush(pending);
      pending = "";
    },
  };
}

export interface Activity {
  update(change: { label?: ActivityNotice; detail?: string | null }): Promise<void>;
  /** Appends to the activity's reasoning summary (batched). */
  reasoning(text: string): Promise<void>;
  /** Ends the activity; later calls do nothing. */
  done(): Promise<void>;
}

/** Publishes a running activity and returns its handle. */
export async function startActivity(
  db: Db,
  sessionId: string,
  label: ActivityNotice,
  detail: string | null = null,
): Promise<Activity> {
  const id = uuidv7();
  let current: ActivityEvent = { id, label, detail, state: "running" };
  const reasoning = batcher((text) =>
    publish(db, sessionId, "activity-reasoning", { id, text }).then(() => undefined),
  );
  await publish(db, sessionId, "activity", current);
  return {
    async update(change) {
      if (current.state === "done") return;
      current = { ...current, ...change };
      await publish(db, sessionId, "activity", current);
    },
    async reasoning(text) {
      if (current.state === "running") await reasoning.add(text);
    },
    async done() {
      if (current.state === "done") return;
      current = { ...current, state: "done" };
      await reasoning.end();
      await publish(db, sessionId, "activity", current);
    },
  };
}

/**
 * Tells the learner a job failed (an `error` event: `{ error: <notice> }`, worded by the web, design
 * §9.3), for what they can act on.
 */
export async function publishFailure(db: Db, sessionId: string, failure: FailureNotice) {
  await publish(db, sessionId, "error", { error: failure });
}

/** Runs the work as an activity, ended however the work ends. */
export async function withActivity<T>(
  db: Db,
  sessionId: string,
  label: ActivityNotice,
  run: (activity: Activity) => Promise<T>,
): Promise<T> {
  const activity = await startActivity(db, sessionId, label);
  try {
    return await run(activity);
  } finally {
    await activity.done();
  }
}

/** The activities still running as of an event id, oldest first. */
export async function runningActivities(
  db: Db,
  sessionId: string,
  upToId: number,
): Promise<ActivityEvent[]> {
  const rows = await db
    .select({ data: sessionEvents.data })
    .from(sessionEvents)
    .where(
      and(
        eq(sessionEvents.sessionId, sessionId),
        eq(sessionEvents.type, "activity"),
        lte(sessionEvents.id, upToId),
      ),
    )
    .orderBy(asc(sessionEvents.id));
  const latest = new Map<string, ActivityEvent>();
  for (const { data } of rows) {
    const activity = data as ActivityEvent;
    // An update keeps the activity's place: it is ordered by when it started.
    latest.set(activity.id, activity);
  }
  return [...latest.values()].filter((a) => a.state === "running");
}

export interface EventHub {
  /** Calls `wake` whenever the session gets new events; returns the unsubscribe function. */
  subscribe(sessionId: string, wake: () => void): Promise<() => void>;
  close(): Promise<void>;
}

/** One LISTEN connection per API process, fanned out to that process's open streams. */
export function createEventHub(client: Sql): EventHub {
  const subscribers = new Map<string, Set<() => void>>();
  let listening: ReturnType<Sql["listen"]> | null = null;
  const ensureListening = () => {
    listening ??= client.listen(CHANNEL, (sessionId) => {
      for (const wake of subscribers.get(sessionId) ?? []) wake();
    });
    return listening;
  };

  return {
    async subscribe(sessionId, wake) {
      await ensureListening();
      let set = subscribers.get(sessionId);
      if (!set) subscribers.set(sessionId, (set = new Set()));
      set.add(wake);
      return () => {
        set.delete(wake);
        if (set.size === 0) subscribers.delete(sessionId);
      };
    },
    async close() {
      if (listening) await (await listening).unlisten();
    },
  };
}
