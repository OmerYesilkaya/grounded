import { and, asc, eq, gt, sessionEvents, sql, type Db } from "@grounded/db";
import type { Sql } from "postgres";

const CHANNEL = "session_events";

/** Appends an event to the session's log and wakes its open streams. Returns the event id. */
export async function publish(
  db: Db,
  sessionId: string,
  type: string,
  data: unknown,
): Promise<number> {
  const [row] = await db
    .insert(sessionEvents)
    .values({ sessionId, type, data })
    .returning({ id: sessionEvents.id });
  if (!row) throw new Error("event insert returned nothing");
  await db.execute(sql`select pg_notify(${CHANNEL}, ${sessionId})`);
  return row.id;
}

export async function eventsAfter(db: Db, sessionId: string, afterId: number) {
  return db
    .select()
    .from(sessionEvents)
    .where(and(eq(sessionEvents.sessionId, sessionId), gt(sessionEvents.id, afterId)))
    .orderBy(asc(sessionEvents.id));
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
