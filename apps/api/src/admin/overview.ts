import type { Overview } from "@grounded/core/admin";
import { sql, type Db } from "@grounded/db";
import { costOf, TOKEN_SUMS, type ModelTokens } from "./cost.js";
import { callsWhere, iso, sessionsWhere, type AdminFilters } from "./filters.js";

/*
 * The admin panel's overview (design §10.1): where the teaching broke, across every learner, for
 * the calls and sessions the filters keep.
 */

/** A session's phases in the order a session goes through them; a final has audit and teach-back. */
export const PHASE_ORDER = [
  "review",
  "probe",
  "plan",
  "lesson",
  "homework",
  "audit",
  "teach-back",
  "close",
  "closed",
] as const;

/** An open session with nothing happening for this long has stopped (design §10.1). */
export const IDLE_AFTER = "1 day";

type Rows<T> = T[];

export async function overview(db: Db, f: AdminFilters): Promise<Overview> {
  const sw = sessionsWhere(f);
  const cw = callsWhere(f);
  const q = <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
    db.execute<T>(query) as Promise<Rows<T>>;

  const [
    totals,
    callTotals,
    checks,
    settling,
    judged,
    issues,
    failedCalls,
    shown,
    latestShown,
    failedSteps,
    unanswered,
    asideTotal,
    asides,
    heldTotal,
    held,
    phases,
    idle,
    plans,
    assignments,
    reviews,
    callGroups,
    durations,
  ] = await Promise.all([
    q<{ learners: number; sessions: number; closed: number }>(sql`
      select count(distinct s.user_id)::int as learners, count(*)::int as sessions,
        count(s.closed_at)::int as closed
      from learning_sessions s where ${sw}`),
    q<ModelTokens & { calls: number }>(sql`
      select u.model, count(*)::int as calls, ${TOKEN_SUMS}
      from usage_events u where ${cw} group by u.model`),
    q<{ model: string; checked: number; firstTry: number; misses: number }>(sql`
      with verdicts as (
        select cm.session_id, cm.verdict,
          row_number() over (partition by cm.session_id, cm.step_id order by cm.created_at, cm.id) as n
        from check_messages cm join learning_sessions s on s.id = cm.session_id
        where ${sw} and cm.verdict is not null)
      select coalesce((select u.model from usage_events u
          where u.session_id = v.session_id and u.purpose = 'check'
          order by u.created_at desc limit 1), 'unknown') as model,
        count(*) filter (where v.n = 1)::int as checked,
        count(*) filter (where v.n = 1 and v.verdict = 'landed')::int as "firstTry",
        count(*) filter (where v.verdict = 'missed')::int as misses
      from verdicts v group by 1 order by 2 desc`),
    q<{ settling: number }>(sql`
      select count(*)::int as settling
      from learning_sessions s cross join jsonb_each(s.state -> 'steps') step
      where ${sw} and step.value ->> 'status' = 'settling'`),
    q<{ purpose: string; model: string; judged: number; rewrites: number; passed: number }>(sql`
      select u.purpose, u.model, count(*)::int as judged,
        count(*) filter (where (mc.verdict ->> 'rewrite')::int > 0)::int as rewrites,
        count(*) filter (where jsonb_array_length(mc.verdict -> 'issues') = 0)::int as passed
      from model_calls mc join usage_events u on u.id = mc.usage_event_id
      where ${cw} and mc.verdict is not null
      group by 1, 2 order by 3 desc`),
    q<{
      code: string;
      purpose: string;
      model: string;
      count: number;
      sessions: number;
      example: string;
    }>(sql`
      select coalesce(i ->> 'code', '(no code)') as code, u.purpose, u.model, count(*)::int as count,
        count(distinct mc.session_id)::int as sessions,
        (array_agg(i ->> 'message' order by u.created_at desc))[1] as example
      from model_calls mc join usage_events u on u.id = mc.usage_event_id
        cross join jsonb_array_elements(mc.verdict -> 'issues') i
      where ${cw} and mc.verdict is not null
      group by 1, 2, 3 order by 4 desc`),
    q<{ kind: string; model: string; count: number }>(sql`
      select coalesce(u.error_kind, 'unknown') as kind, u.model, count(*)::int as count
      from usage_events u where ${cw} and u.status = 'error'
      group by 1, 2 order by 3 desc`),
    q<{ shown: number }>(sql`
      select count(*)::int as shown
      from session_events e join learning_sessions s on s.id = e.session_id
      where ${sw} and e.type = 'error'`),
    q<{ sessionId: string; learner: number; message: string; at: string }>(sql`
      select e.session_id as "sessionId", us.learner_number as learner,
        coalesce(e.data ->> 'message', e.data::text) as message, ${iso("e.created_at")} as at
      from session_events e join learning_sessions s on s.id = e.session_id
        join users us on us.id = s.user_id
      where ${sw} and e.type = 'error' order by e.id desc limit 10`),
    q<{ failedSteps: number }>(sql`
      select coalesce(sum(jsonb_array_length(l.failed_steps)), 0)::int as "failedSteps"
      from lessons l join learning_sessions s on s.id = l.session_id where ${sw}`),
    q<{ checks: number; asides: number; reviewThreads: number }>(sql`
      select
        (select count(*) from check_messages cm join learning_sessions s on s.id = cm.session_id
          where ${sw} and cm.failure is not null)::int as checks,
        (select count(*) from aside_messages am join asides a on a.id = am.aside_id
          join learning_sessions s on s.id = a.session_id
          where ${sw} and am.failure is not null)::int as asides,
        (select count(*) from review_messages rm join review_comments rc on rc.id = rm.comment_id
          join reviews r on r.id = rc.review_id join assignments a on a.id = r.assignment_id
          join learning_sessions s on s.id = a.session_id
          where ${sw} and rm.failure is not null)::int as "reviewThreads"`),
    q<{ total: number }>(sql`
      select count(*)::int as total
      from asides a join learning_sessions s on s.id = a.session_id where ${sw}`),
    q<{
      id: string;
      sessionId: string;
      learner: number;
      stepId: string;
      quote: string;
      question: string | null;
      at: string;
    }>(sql`
      select a.id, a.session_id as "sessionId", us.learner_number as learner, a.step_id as "stepId",
        a.anchor ->> 'quote' as quote,
        (select m.text from aside_messages m where m.aside_id = a.id and m.role = 'learner'
          order by m.created_at, m.id limit 1) as question,
        ${iso("a.created_at")} as at
      from asides a join learning_sessions s on s.id = a.session_id
        join users us on us.id = s.user_id
      where ${sw} order by a.created_at desc limit 20`),
    q<{ total: number }>(sql`
      select count(*)::int as total
      from lessons l join learning_sessions s on s.id = l.session_id
        cross join jsonb_each_text(l.already_held) held
      where ${sw}`),
    q<{ sessionId: string; learner: number; stepId: string; what: string; at: string }>(sql`
      select l.session_id as "sessionId", us.learner_number as learner, held.key as "stepId",
        held.value as what, ${iso("l.updated_at")} as at
      from lessons l join learning_sessions s on s.id = l.session_id
        join users us on us.id = s.user_id
        cross join jsonb_each_text(l.already_held) held
      where ${sw} order by l.updated_at desc limit 20`),
    q<{ id: string; phase: string }>(sql`
      select s.id, e.data ->> 'phase' as phase
      from learning_sessions s join session_events e on e.session_id = s.id and e.type = 'state'
      where ${sw}
      union all select s.id, s.state ->> 'phase' from learning_sessions s where ${sw}
      union all select s.id, 'closed' from learning_sessions s
        where ${sw} and s.closed_at is not null`),
    q<{ phase: string; sessions: number }>(sql`
      select s.state ->> 'phase' as phase, count(*)::int as sessions
      from learning_sessions s
      where ${sw} and s.closed_at is null
        and coalesce((select max(e.created_at) from session_events e where e.session_id = s.id),
          s.created_at) < now() - ${IDLE_AFTER}::interval
      group by 1`),
    q<{ plans: number; sessions: number }>(sql`
      select plans, count(*)::int as sessions from (
        select (select count(*) from session_messages m
          where m.session_id = s.id and m.kind = 'plan' and m.role = 'tutor')::int as plans
        from learning_sessions s where ${sw} and coalesce(s.kind, 'normal') = 'normal') per
      group by plans order by plans`),
    q<{
      kind: string;
      total: number;
      handedIn: number;
      putOff: number;
      folded: number;
      open: number;
    }>(sql`
      select a.kind, count(*)::int as total,
        count(*) filter (where a.submitted_at is not null)::int as "handedIn",
        count(*) filter (where a.submitted_at is null and a.subsumed_by is null
          and a.snoozed_until is not null)::int as "putOff",
        count(*) filter (where a.subsumed_by is not null)::int as folded,
        count(*) filter (where a.submitted_at is null and a.subsumed_by is null)::int as open
      from assignments a join learning_sessions s on s.id = a.session_id
      where ${sw} group by a.kind order by a.kind`),
    q<{ status: string; count: number }>(sql`
      select r.status, count(*)::int as count
      from reviews r join assignments a on a.id = r.assignment_id
        join learning_sessions s on s.id = a.session_id
      where ${sw} group by r.status order by r.status`),
    q<ModelTokens & { purpose: string; calls: number; failures: number }>(sql`
      select u.purpose, u.model, count(*)::int as calls,
        count(*) filter (where u.status = 'error')::int as failures, ${TOKEN_SUMS}
      from usage_events u where ${cw} group by 1, 2`),
    q<{ purpose: string; p50Ms: number | null; p90Ms: number | null }>(sql`
      select u.purpose,
        percentile_cont(0.5) within group (order by u.duration_ms) as "p50Ms",
        percentile_cont(0.9) within group (order by u.duration_ms) as "p90Ms"
      from usage_events u
      where ${cw} and u.status = 'ok' and u.duration_ms is not null group by 1`),
  ]);

  const furthest = new Map<string, number>();
  for (const { id, phase } of phases) {
    const rank = PHASE_ORDER.indexOf(phase as (typeof PHASE_ORDER)[number]);
    furthest.set(id, Math.max(furthest.get(id) ?? -1, rank));
  }
  const reached = new Map<string, number>();
  for (const rank of furthest.values()) {
    const phase = PHASE_ORDER[rank] ?? "unknown";
    reached.set(phase, (reached.get(phase) ?? 0) + 1);
  }

  const byPurpose = new Map<string, Overview["calls"]["byPurpose"][number]>();
  const byModel = new Map<string, Overview["calls"]["byModel"][number]>();
  const timing = new Map(durations.map((d) => [d.purpose, d]));
  for (const row of callGroups) {
    const cost = costOf([row]);
    const purpose = byPurpose.get(row.purpose) ?? {
      purpose: row.purpose,
      calls: 0,
      failures: 0,
      p50Ms: timing.get(row.purpose)?.p50Ms ?? null,
      p90Ms: timing.get(row.purpose)?.p90Ms ?? null,
      costUsd: 0,
    };
    purpose.calls += row.calls;
    purpose.failures += row.failures;
    purpose.costUsd += cost;
    byPurpose.set(row.purpose, purpose);
    const model = byModel.get(row.model) ?? { model: row.model, calls: 0, failures: 0, costUsd: 0 };
    model.calls += row.calls;
    model.failures += row.failures;
    model.costUsd += cost;
    byModel.set(row.model, model);
  }

  const sum = <T>(rows: readonly T[], key: (row: T) => number) =>
    rows.reduce((total, row) => total + key(row), 0);

  return {
    totals: {
      learners: totals[0]?.learners ?? 0,
      sessions: totals[0]?.sessions ?? 0,
      closed: totals[0]?.closed ?? 0,
      calls: sum(callTotals, (r) => r.calls),
      costUsd: costOf(callTotals),
    },
    checks: {
      checked: sum(checks, (r) => r.checked),
      firstTry: sum(checks, (r) => r.firstTry),
      misses: sum(checks, (r) => r.misses),
      settling: settling[0]?.settling ?? 0,
      byModel: checks,
    },
    validators: { byPurpose: judged, issues },
    failures: {
      calls: failedCalls,
      shown: shown[0]?.shown ?? 0,
      latestShown,
      failedSteps: failedSteps[0]?.failedSteps ?? 0,
      unanswered: unanswered[0] ?? { checks: 0, asides: 0, reviewThreads: 0 },
    },
    asides: {
      total: asideTotal[0]?.total ?? 0,
      latest: asides,
    },
    alreadyHeld: {
      total: heldTotal[0]?.total ?? 0,
      latest: held,
    },
    sessions: {
      furthest: PHASE_ORDER.filter((phase) => reached.has(phase)).map((phase) => ({
        phase,
        sessions: reached.get(phase) ?? 0,
      })),
      idle,
      plans,
    },
    homework: { assignments, reviews },
    calls: {
      byPurpose: [...byPurpose.values()].sort((a, b) => b.calls - a.calls),
      byModel: [...byModel.values()].sort((a, b) => b.calls - a.calls),
    },
  };
}
