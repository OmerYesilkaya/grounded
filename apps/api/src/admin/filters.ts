import { sql, type Db, type SQL } from "@grounded/db";

/**
 * The filters every view of the admin panel takes (design §10.1): a period, the model and the
 * version of the method. Calls match on their own; a session matches when any of its calls does.
 */
export interface AdminFilters {
  /** Calls and sessions from this time on; null: all. */
  since: Date | null;
  model: string | null;
  /** `usage_events.method_version`. */
  method: string | null;
}

export const PERIODS = { "7": 7, "30": 30, "90": 90, all: null } as const;

/** A query parameter's value, or null when it is missing or blank. */
const given = (value: string | undefined) => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

export function parseFilters(query: Record<string, string | undefined>, now = new Date()) {
  const period = query.period && query.period in PERIODS ? query.period : "30";
  const days = PERIODS[period as keyof typeof PERIODS];
  const filters: AdminFilters = {
    since: days === null ? null : new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
    model: given(query.model),
    method: given(query.method),
  };
  return filters;
}

/** The calls (`usage_events`, aliased `u`) the filters keep. */
export function callsWhere(f: AdminFilters): SQL {
  return sql.join(
    [
      sql`true`,
      ...(f.since ? [sql`u.created_at >= ${f.since.toISOString()}::timestamptz`] : []),
      ...(f.model ? [sql`u.model = ${f.model}`] : []),
      ...(f.method ? [sql`u.method_version = ${f.method}`] : []),
    ],
    sql` and `,
  );
}

/** The sessions (`learning_sessions`, aliased `s`) the filters keep. */
export function sessionsWhere(f: AdminFilters): SQL {
  const byCalls =
    f.model || f.method
      ? [
          sql`exists (select 1 from usage_events u where u.session_id = s.id and ${callsWhere({
            ...f,
            since: null,
          })})`,
        ]
      : [];
  return sql.join(
    [
      sql`true`,
      ...(f.since ? [sql`s.created_at >= ${f.since.toISOString()}::timestamptz`] : []),
      ...byCalls,
    ],
    sql` and `,
  );
}

/** A timestamp as ISO 8601 text, as the panel is sent times (raw queries return Postgres's text). */
export const iso = (column: string) => sql.raw(`to_json(${column}) #>> '{}'`);

/** The models and method versions the calls were made with, for the panel's filters. */
export async function filterOptions(db: Db) {
  const [models, methods] = await Promise.all([
    db.execute<{ model: string; calls: number }>(sql`
      select model, count(*)::int as calls from usage_events group by model order by 2 desc`),
    db.execute<{ version: string; calls: number; firstSeen: string; lastSeen: string }>(sql`
      select method_version as version, count(*)::int as calls,
        to_json(min(created_at)) #>> '{}' as "firstSeen",
        to_json(max(created_at)) #>> '{}' as "lastSeen"
      from usage_events where method_version is not null
      group by method_version order by "lastSeen" desc`),
  ]);
  return { models: [...models], methods: [...methods] };
}
