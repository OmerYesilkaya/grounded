import type { LearnerRow } from "@grounded/core/admin";
import { sql, type Db } from "@grounded/db";
import { iso } from "./filters.js";

export async function listLearners(db: Db): Promise<LearnerRow[]> {
  const rows = await db.execute<{
    learner: number;
    joinedAt: string;
    tracks: { id: string; title: string; sessions: number }[] | null;
    sessions: number;
    lastActivity: string | null;
  }>(sql`
    select us.learner_number as learner, ${iso("us.created_at")} as "joinedAt",
      (select json_agg(json_build_object('id', t.id, 'title', t.title, 'sessions',
          (select count(*) from learning_sessions s where s.track_id = t.id)) order by t.created_at)
        from tracks t where t.user_id = us.id) as tracks,
      (select count(*) from learning_sessions s where s.user_id = us.id)::int as sessions,
      (select to_json(max(u.created_at)) #>> '{}' from usage_events u
        where u.user_id = us.id) as "lastActivity"
    from users us order by us.learner_number`);
  return rows.map((row) => ({ ...row, tracks: row.tracks ?? [] }));
}

/** A learner's email, when the operator asks for it; null for a number no one has. */
export async function learnerEmail(db: Db, learner: number): Promise<string | null> {
  const [row] = await db.execute<{ email: string }>(
    sql`select email from users where learner_number = ${learner}`,
  );
  return row?.email ?? null;
}
