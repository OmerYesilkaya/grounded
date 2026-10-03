import type { SessionRow, SessionsPage } from "@grounded/core/admin";
import { sql, type Db, type SQL } from "@grounded/db";
import { costOf, TOKEN_SUMS, type ModelTokens } from "./cost.js";
import { iso, sessionsWhere, type AdminFilters } from "./filters.js";
import { IDLE_AFTER } from "./overview.js";

/*
 * The admin panel's list of sessions (design §10.1): newest first, each with what went wrong in it,
 * for the filters and for the links from the overview's figures.
 */

/** What a session has, for the overview's links: `has=asides` lists the sessions with asides. */
export const HAS = {
  errors: sql`(exists (select 1 from session_events e where e.session_id = s.id and e.type = 'error')
    or exists (select 1 from usage_events u where u.session_id = s.id and u.status = 'error'))`,
  asides: sql`exists (select 1 from asides a where a.session_id = s.id)`,
  misses: sql`exists (select 1 from check_messages cm where cm.session_id = s.id and cm.verdict = 'missed')`,
  "already-held": sql`exists (select 1 from lessons l where l.session_id = s.id and l.already_held <> '{}'::jsonb)`,
  "failed-steps": sql`exists (select 1 from lessons l where l.session_id = s.id and l.failed_steps <> '[]'::jsonb)`,
  settling: sql`exists (select 1 from jsonb_each(s.state -> 'steps') step where step.value ->> 'status' = 'settling')`,
  rewrites: sql`exists (select 1 from model_calls mc where mc.session_id = s.id and (mc.verdict ->> 'rewrite')::int > 0)`,
  idle: sql`(s.closed_at is null and coalesce((select max(e.created_at) from session_events e
    where e.session_id = s.id), s.created_at) < now() - ${IDLE_AFTER}::interval)`,
} as const;

export interface SessionQuery {
  learner: number | null;
  trackId: string | null;
  /** A validator's issue code the session's calls were given. */
  issue: string | null;
  has: keyof typeof HAS | null;
  /** The phase it is in, `closed` for a closed one. */
  phase: string | null;
  /** Sessions started before this time (the next page). */
  before: Date | null;
}

/** What the list's first query gives; the rest is added per page. */
type SessionBase = Pick<
  SessionRow,
  | "id"
  | "learner"
  | "trackId"
  | "trackTitle"
  | "kind"
  | "phase"
  | "startedAt"
  | "closedAt"
  | "lastActivity"
  | "errors"
  | "asides"
>;

const PAGE = 50;

const idList = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

export async function listSessions(
  db: Db,
  f: AdminFilters,
  query: SessionQuery,
): Promise<SessionsPage> {
  const where: SQL[] = [sessionsWhere(f)];
  if (query.learner !== null) where.push(sql`us.learner_number = ${query.learner}`);
  if (query.trackId) where.push(sql`s.track_id = ${query.trackId}`);
  if (query.issue)
    where.push(sql`exists (select 1 from model_calls mc
      cross join jsonb_array_elements(mc.verdict -> 'issues') i
      where mc.session_id = s.id and coalesce(i ->> 'code', '(no code)') = ${query.issue})`);
  if (query.has) where.push(HAS[query.has]);
  if (query.phase === "closed") where.push(sql`s.closed_at is not null`);
  else if (query.phase)
    where.push(sql`s.closed_at is null and s.state ->> 'phase' = ${query.phase}`);
  if (query.before) where.push(sql`s.created_at < ${query.before.toISOString()}::timestamptz`);

  const rows = await db.execute<SessionBase>(sql`
    select s.id, us.learner_number as learner, t.id as "trackId", t.title as "trackTitle", s.kind,
      case when s.closed_at is not null then 'closed' else s.state ->> 'phase' end as phase,
      ${iso("s.created_at")} as "startedAt", ${iso("s.closed_at")} as "closedAt",
      to_json(coalesce((select max(e.created_at) from session_events e where e.session_id = s.id),
        s.created_at)) #>> '{}' as "lastActivity",
      (select count(*) from session_events e
        where e.session_id = s.id and e.type = 'error')::int as errors,
      (select count(*) from asides a where a.session_id = s.id)::int as asides
    from learning_sessions s join users us on us.id = s.user_id join tracks t on t.id = s.track_id
    where ${sql.join(where, sql` and `)}
    order by s.created_at desc, s.id desc limit ${PAGE + 1}`);
  const page = rows.slice(0, PAGE);
  if (page.length === 0) return { sessions: [], next: null };
  const ids = idList(page.map((row) => row.id));

  const [calls, verdicts, checks] = await Promise.all([
    db.execute<ModelTokens & { sessionId: string; calls: number; failures: number }>(sql`
      select u.session_id as "sessionId", u.model, count(*)::int as calls,
        count(*) filter (where u.status = 'error')::int as failures, ${TOKEN_SUMS}
      from usage_events u where u.session_id in (${ids}) group by 1, 2`),
    db.execute<{ sessionId: string; rewrites: number; issues: number }>(sql`
      select mc.session_id as "sessionId",
        count(*) filter (where (mc.verdict ->> 'rewrite')::int > 0)::int as rewrites,
        coalesce(sum(jsonb_array_length(mc.verdict -> 'issues')), 0)::int as issues
      from model_calls mc where mc.session_id in (${ids}) and mc.verdict is not null group by 1`),
    db.execute<{ sessionId: string; checked: number; firstTry: number; misses: number }>(sql`
      with verdicts as (
        select cm.session_id, cm.verdict,
          row_number() over (partition by cm.session_id, cm.step_id order by cm.created_at, cm.id) as n
        from check_messages cm where cm.session_id in (${ids}) and cm.verdict is not null)
      select session_id as "sessionId", count(*) filter (where n = 1)::int as checked,
        count(*) filter (where n = 1 and verdict = 'landed')::int as "firstTry",
        count(*) filter (where verdict = 'missed')::int as misses
      from verdicts group by 1`),
  ]);

  const sessions = page.map((row): SessionRow => {
    const own = calls.filter((c) => c.sessionId === row.id);
    const verdict = verdicts.find((v) => v.sessionId === row.id);
    const check = checks.find((c) => c.sessionId === row.id);
    return {
      ...row,
      models: own.map((c) => c.model).sort(),
      calls: own.reduce((n, c) => n + c.calls, 0),
      failedCalls: own.reduce((n, c) => n + c.failures, 0),
      costUsd: costOf(own),
      checked: check?.checked ?? 0,
      firstTry: check?.firstTry ?? 0,
      misses: check?.misses ?? 0,
      rewrites: verdict?.rewrites ?? 0,
      issues: verdict?.issues ?? 0,
    };
  });
  return { sessions, next: rows.length > PAGE ? (page.at(-1)?.startedAt ?? null) : null };
}
