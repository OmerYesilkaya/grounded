import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  formatCost,
  formatTokens,
  monthName,
  usageQuery,
  type UsageReport,
  type UsageTotal,
} from "@/lib/usage";

const EMPTY: UsageTotal = {
  calls: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  costUsd: null,
  unpriced: 0,
};

/** This month in the browser's time zone, as the API keys months: "2026-09". */
function thisMonth(now = new Date()): string {
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** "1.2M in (840K from the cache) · 96K out · 58 calls". */
function tokensLine(total: UsageTotal): string {
  const cached = total.cachedInputTokens
    ? ` (${formatTokens(total.cachedInputTokens)} from the cache)`
    : "";
  const calls = `${String(total.calls)} ${total.calls === 1 ? "call" : "calls"}`;
  return `${formatTokens(total.inputTokens)} tokens in${cached} · ${formatTokens(total.outputTokens)} out · ${calls}`;
}

function Unpriced({ total }: { total: UsageTotal }) {
  if (!total.unpriced) return null;
  return (
    <p className="mt-1 text-[12.5px] text-subtle-foreground">
      Not counted: {total.unpriced} {total.unpriced === 1 ? "call" : "calls"} on a model without a
      listed price.
    </p>
  );
}

/** What the learner's key has spent, per month and per session (design §4.4). */
export function UsagePage() {
  const usage = useQuery(usageQuery);
  return (
    <main className="mx-auto w-full max-w-2xl px-6 pt-24 pb-24">
      <p className="text-xs tracking-widest text-subtle-foreground uppercase">Usage</p>
      <h1 className="mt-1 font-serif text-3xl font-semibold tracking-tight">
        What your key has spent
      </h1>
      <p className="mt-2 max-w-prose text-sm text-muted-foreground">
        Estimated from each model&apos;s list price. Your provider&apos;s bill is the exact figure.
      </p>
      {usage.data && <Report report={usage.data} />}
      {usage.error && (
        <p className="mt-10 text-sm text-destructive">Usage couldn&apos;t be loaded.</p>
      )}
    </main>
  );
}

function Report({ report }: { report: UsageReport }) {
  const current = thisMonth();
  const now = report.months.find((m) => m.month === current) ?? { month: current, ...EMPTY };
  const earlier = report.months.filter((m) => m.month !== current);
  const most = Math.max(...earlier.map((m) => m.costUsd ?? 0), 0);

  return (
    <>
      <section aria-labelledby="this-month" className="mt-10 rounded-lg border bg-card px-6 py-5">
        <h2 id="this-month" className="text-[13px] text-muted-foreground">
          {monthName(current, { year: false })}, so far
        </h2>
        <p className="mt-1 font-serif text-4xl font-semibold tracking-tight tabular-nums">
          {now.calls ? formatCost(now.costUsd) : "$0.00"}
        </p>
        {now.calls > 0 && (
          <p className="mt-2 text-[13px] text-subtle-foreground tabular-nums">{tokensLine(now)}</p>
        )}
        <Unpriced total={now} />
      </section>

      {earlier.length > 0 && (
        <section aria-labelledby="earlier" className="mt-10">
          <h2 id="earlier" className="text-xs tracking-widest text-subtle-foreground uppercase">
            Earlier months
          </h2>
          <ul className="mt-3 divide-y">
            {earlier.map((m) => (
              <li
                key={m.month}
                className="grid grid-cols-[9rem_1fr_5rem] items-center gap-4 py-2.5 max-sm:grid-cols-[6.5rem_1fr_4.5rem] max-sm:gap-3"
              >
                <span className="text-sm">{monthName(m.month)}</span>
                <span aria-hidden className="h-1 rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full bg-primary/60"
                    style={{ width: `${String(most ? ((m.costUsd ?? 0) / most) * 100 : 0)}%` }}
                  />
                </span>
                <span className="text-right text-sm tabular-nums" title={tokensLine(m)}>
                  {formatCost(m.costUsd)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="by-session" className="mt-10">
        <h2 id="by-session" className="text-xs tracking-widest text-subtle-foreground uppercase">
          By session
        </h2>
        {report.sessions.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No sessions yet.</p>
        ) : (
          <ul className="mt-3 divide-y">
            {report.sessions.map((s) => (
              <li key={s.id}>
                <Link
                  to="/sessions/$sessionId"
                  params={{ sessionId: s.id }}
                  className="-mx-2 grid grid-cols-[1fr_auto] items-baseline gap-x-4 rounded-md px-2 py-2.5 hover:bg-muted"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{s.trackTitle}</span>
                    <span className="block text-[11px] tracking-wider text-subtle-foreground uppercase">
                      Session {s.number} ·{" "}
                      {new Date(s.startedAt).toLocaleDateString("en", {
                        day: "numeric",
                        month: "short",
                      })}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block text-sm tabular-nums">{formatCost(s.costUsd)}</span>
                    <span className="block text-[11px] text-subtle-foreground tabular-nums">
                      {formatTokens(s.inputTokens + s.outputTokens)} tokens
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
