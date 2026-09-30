import { useQuery } from "@tanstack/react-query";
import { PhoneBar } from "@/components/page-bar";
import { Link } from "@tanstack/react-router";
import { useFormat, useT, type Formats, type Messages } from "@/i18n";
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

/** "1.2M tokens in (840K from the cache) · 96K out · 58 calls". */
function tokensLine(total: UsageTotal, t: Messages["account"]["usage"], format: Formats): string {
  return t.tokensLine({
    input: formatTokens(total.inputTokens, format),
    cached: total.cachedInputTokens ? formatTokens(total.cachedInputTokens, format) : null,
    output: formatTokens(total.outputTokens, format),
    calls: t.calls(total.calls),
  });
}

function Unpriced({ total }: { total: UsageTotal }) {
  const t = useT().account.usage;
  if (!total.unpriced) return null;
  return (
    <p className="mt-1 text-[12.5px] text-subtle-foreground">
      {t.unpriced(t.calls(total.unpriced))}
    </p>
  );
}

/** What the learner's key has spent, per month and per session (design §4.4). */
export function UsagePage() {
  const usage = useQuery(usageQuery);
  const t = useT().account.usage;
  return (
    <>
      <PhoneBar />
      <main className="mx-auto w-full max-w-2xl px-6 pt-24 pb-24 max-md:pt-10">
        <p className="text-xs tracking-widest text-subtle-foreground uppercase">{t.eyebrow}</p>
        <h1 className="mt-1 font-serif text-3xl font-semibold tracking-tight">{t.title}</h1>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">{t.intro}</p>
        {usage.data && <Report report={usage.data} />}
        {usage.error && <p className="mt-10 text-sm text-destructive">{t.failed}</p>}
      </main>
    </>
  );
}

function Report({ report }: { report: UsageReport }) {
  const { account, common } = useT();
  const t = account.usage;
  const format = useFormat();
  const current = thisMonth();
  const now = report.months.find((m) => m.month === current) ?? { month: current, ...EMPTY };
  const earlier = report.months.filter((m) => m.month !== current);
  const most = Math.max(...earlier.map((m) => m.costUsd ?? 0), 0);

  return (
    <>
      <section aria-labelledby="this-month" className="mt-10 rounded-lg border bg-card px-6 py-5">
        <h2 id="this-month" className="text-[13px] text-muted-foreground">
          {t.soFar(monthName(current, format, { year: false }))}
        </h2>
        <p className="mt-1 font-serif text-4xl font-semibold tracking-tight tabular-nums">
          {formatCost(now.calls ? now.costUsd : 0, format)}
        </p>
        {now.calls > 0 && (
          <p className="mt-2 text-[13px] text-subtle-foreground tabular-nums">
            {tokensLine(now, t, format)}
          </p>
        )}
        <Unpriced total={now} />
      </section>

      {earlier.length > 0 && (
        <section aria-labelledby="earlier" className="mt-10">
          <h2 id="earlier" className="text-xs tracking-widest text-subtle-foreground uppercase">
            {t.earlier}
          </h2>
          <ul className="mt-3 divide-y">
            {earlier.map((m) => (
              <li
                key={m.month}
                className="grid grid-cols-[9rem_1fr_5rem] items-center gap-4 py-2.5 max-sm:grid-cols-[6.5rem_1fr_4.5rem] max-sm:gap-3"
              >
                <span className="text-sm">{monthName(m.month, format)}</span>
                <span aria-hidden className="h-1 rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full bg-primary/60"
                    style={{ width: `${String(most ? ((m.costUsd ?? 0) / most) * 100 : 0)}%` }}
                  />
                </span>
                <span className="text-right text-sm tabular-nums" title={tokensLine(m, t, format)}>
                  {formatCost(m.costUsd, format)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="by-session" className="mt-10">
        <h2 id="by-session" className="text-xs tracking-widest text-subtle-foreground uppercase">
          {t.bySession}
        </h2>
        {report.sessions.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{t.noSessions}</p>
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
                      {common.session(s.number)} ·{" "}
                      {format.date(s.startedAt, { day: "numeric", month: "short" })}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block text-sm tabular-nums">
                      {formatCost(s.costUsd, format)}
                    </span>
                    <span className="block text-[11px] text-subtle-foreground tabular-nums">
                      {t.tokens(formatTokens(s.inputTokens + s.outputTokens, format))}
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
