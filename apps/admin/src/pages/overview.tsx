import type { Overview } from "@grounded/core/admin";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { FilterBar } from "@/components/filter-bar";
import { Empty, Failed, Loading, Section, ShareBar, Stat, td, tdNum, th } from "@/components/ui";
import { adminApi, queryString } from "@/lib/api";
import { filtersOf, type Filters, type SessionSearch } from "@/lib/filters";
import { count, duration, learnerName, percent, plural, usd, when } from "@/lib/format";

const route = getRouteApi("/");

/** The overview (design §10.1): where the teaching broke, each figure linked to its sessions. */
export function OverviewPage() {
  const filters = route.useSearch();
  const navigate = route.useNavigate();
  const overview = useQuery({
    queryKey: ["overview", filters],
    queryFn: () => adminApi.overview(queryString({ ...filters })),
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Where the teaching broke</h1>
          <p className="text-sm text-muted-foreground">
            Every figure opens the sessions behind it.
          </p>
        </div>
        <FilterBar
          filters={filters}
          onChange={(next) => {
            void navigate({ search: next });
          }}
        />
      </div>
      {overview.isPending ? (
        <Loading />
      ) : overview.isError ? (
        <Failed error={overview.error} />
      ) : (
        <Figures o={overview.data} filters={filtersOf(filters)} />
      )}
    </div>
  );
}

/** A link to the sessions a figure counts. */
function To({
  filters,
  search,
  children,
}: {
  filters: Filters;
  search: Omit<SessionSearch, keyof Filters>;
  children: ReactNode;
}) {
  return (
    <Link
      to="/sessions"
      search={{ ...filters, ...search }}
      className="underline decoration-border-strong underline-offset-2 hover:decoration-primary"
    >
      {children}
    </Link>
  );
}

function Figures({ o, filters }: { o: Overview; filters: Filters }) {
  const furthestTotal = o.sessions.furthest.reduce((n, p) => n + p.sessions, 0);
  const idleTotal = o.sessions.idle.reduce((n, p) => n + p.sessions, 0);
  const planTotal = o.sessions.plans.reduce((n, p) => n + p.sessions, 0);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title="In this period" className="lg:col-span-2">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <Stat label={plural(o.totals.learners, "learner")} value={count(o.totals.learners)} />
          <Stat label={plural(o.totals.sessions, "session")} value={count(o.totals.sessions)} />
          <Stat label="closed" value={count(o.totals.closed)} />
          <Stat label={plural(o.totals.calls, "model call")} value={count(o.totals.calls)} />
          <Stat label="estimated cost" value={usd(o.totals.costUsd)} />
        </div>
      </Section>

      <Section
        title="Checks"
        note="Whether the lesson taught: a check landed on the learner's first answer, or needed repairs."
      >
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="steps checked" value={count(o.checks.checked)} />
          <Stat
            label="landed first try"
            value={percent(o.checks.firstTry, o.checks.checked)}
            detail={`${count(o.checks.firstTry)} of ${count(o.checks.checked)}`}
          />
          <Stat label="misses (repairs)" value={count(o.checks.misses)} />
          <Stat label="left settling" value={count(o.checks.settling)} />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          <To filters={filters} search={{ has: "misses" }}>
            Sessions with misses
          </To>{" "}
          ·{" "}
          <To filters={filters} search={{ has: "settling" }}>
            sessions with steps left settling
          </To>
        </p>
        {o.checks.byModel.length > 1 && (
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr>
                <th className={th}>Model</th>
                <th className={`${th} text-right`}>Checked</th>
                <th className={`${th} text-right`}>First try</th>
                <th className={`${th} text-right`}>Misses</th>
              </tr>
            </thead>
            <tbody>
              {o.checks.byModel.map((m) => (
                <tr key={m.model} className="border-t border-border">
                  <td className={td}>{m.model}</td>
                  <td className={tdNum}>{m.checked}</td>
                  <td className={tdNum}>{percent(m.firstTry, m.checked)}</td>
                  <td className={tdNum}>{m.misses}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Where sessions got to" note="Each session by the furthest phase it reached.">
        {furthestTotal === 0 ? (
          <Empty>No sessions in this period.</Empty>
        ) : (
          <div className="space-y-1.5">
            {o.sessions.furthest.map((p) => (
              <ShareBar
                key={p.phase}
                label={p.phase}
                value={p.sessions}
                of={furthestTotal}
                display={`${String(p.sessions)} · ${percent(p.sessions, furthestTotal)}`}
              />
            ))}
          </div>
        )}
        <h3 className="mt-4 text-xs font-medium text-muted-foreground">
          Open and idle for over a day, by the phase they stopped in
        </h3>
        {idleTotal === 0 ? (
          <Empty>None.</Empty>
        ) : (
          <ul className="mt-1 space-y-1 text-sm">
            {o.sessions.idle.map((p) => (
              <li key={p.phase}>
                <To filters={filters} search={{ has: "idle", phase: p.phase }}>
                  {p.sessions} in {p.phase}
                </To>
              </li>
            ))}
          </ul>
        )}
        {planTotal > 0 && (
          <>
            <h3 className="mt-4 text-xs font-medium text-muted-foreground">
              Plans proposed per session (1: approved as first proposed)
            </h3>
            <div className="mt-1 space-y-1.5">
              {o.sessions.plans.map((p) => (
                <ShareBar
                  key={p.plans}
                  label={`${String(p.plans)} plan${p.plans === 1 ? "" : "s"}`}
                  value={p.sessions}
                  of={planTotal}
                />
              ))}
            </div>
          </>
        )}
      </Section>

      <Section
        title="The validators"
        note="Calls whose reply the app checked, and the rules the models broke: where the prompt and the model disagree."
        className="lg:col-span-2"
      >
        {o.validators.byPurpose.length === 0 ? (
          <Empty>No judged calls in this period.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={th}>Purpose</th>
                <th className={th}>Model</th>
                <th className={`${th} text-right`}>Judged</th>
                <th className={`${th} text-right`}>Passed</th>
                <th className={`${th} text-right`}>Rewrites</th>
              </tr>
            </thead>
            <tbody>
              {o.validators.byPurpose.map((v) => (
                <tr key={`${v.purpose} ${v.model}`} className="border-t border-border">
                  <td className={td}>{v.purpose}</td>
                  <td className={`${td} text-muted-foreground`}>{v.model}</td>
                  <td className={tdNum}>{v.judged}</td>
                  <td className={tdNum}>{percent(v.passed, v.judged)}</td>
                  <td className={tdNum}>{v.rewrites}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {o.validators.issues.length > 0 && (
          <>
            <h3 className="mt-5 text-xs font-medium text-muted-foreground">Issues found</h3>
            <table className="mt-1 w-full text-sm">
              <thead>
                <tr>
                  <th className={th}>Issue</th>
                  <th className={th}>Purpose · model</th>
                  <th className={`${th} text-right`}>Times</th>
                  <th className={`${th} text-right`}>Sessions</th>
                  <th className={th}>Latest message</th>
                </tr>
              </thead>
              <tbody>
                {o.validators.issues.map((i) => (
                  <tr key={`${i.code} ${i.purpose} ${i.model}`} className="border-t border-border">
                    <td className={`${td} font-mono text-xs`}>{i.code}</td>
                    <td className={`${td} text-muted-foreground`}>
                      {i.purpose} · {i.model}
                    </td>
                    <td className={tdNum}>{i.count}</td>
                    <td className={tdNum}>
                      <To filters={filters} search={{ issue: i.code }}>
                        {i.sessions}
                      </To>
                    </td>
                    <td className={`${td} max-w-md text-xs text-muted-foreground`}>
                      <span className="line-clamp-2">{i.example}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Section>

      <Section
        title="Asides"
        note="Questions asked in the margin: each one is a place the lesson wasn't clear enough."
      >
        <p className="text-sm">
          <To filters={filters} search={{ has: "asides" }}>
            {count(o.asides.total)} {plural(o.asides.total, "aside")}
          </To>
        </p>
        <ul className="mt-2 space-y-3">
          {o.asides.latest.map((a) => (
            <li key={a.id} className="text-sm">
              <blockquote className="border-l-2 border-primary/60 pl-2 text-muted-foreground">
                {a.quote}
              </blockquote>
              <p className="mt-1">{a.question ?? <Empty>(no question kept)</Empty>}</p>
              <SessionLink id={a.sessionId} learner={a.learner} at={a.at} />
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Already held"
        note="What learners showed they knew before a step taught it: the lesson was pitched below them."
      >
        <p className="text-sm">
          <To filters={filters} search={{ has: "already-held" }}>
            {count(o.alreadyHeld.total)} {plural(o.alreadyHeld.total, "time")}
          </To>
        </p>
        <ul className="mt-2 space-y-3">
          {o.alreadyHeld.latest.map((h) => (
            <li key={`${h.sessionId} ${h.stepId}`} className="text-sm">
              <p>
                <span className="font-mono text-xs text-muted-foreground">{h.stepId}</span> {h.what}
              </p>
              <SessionLink id={h.sessionId} learner={h.learner} at={h.at} />
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Failures the learner saw">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="errors shown" value={count(o.failures.shown)} />
          <Stat label="lesson steps not written" value={count(o.failures.failedSteps)} />
          <Stat label="check replies not given" value={count(o.failures.unanswered.checks)} />
          <Stat
            label="aside and review replies not given"
            value={count(o.failures.unanswered.asides + o.failures.unanswered.reviewThreads)}
          />
        </div>
        <p className="mt-3 text-xs">
          <To filters={filters} search={{ has: "errors" }}>
            Sessions with errors
          </To>{" "}
          ·{" "}
          <To filters={filters} search={{ has: "failed-steps" }}>
            sessions with steps not written
          </To>
        </p>
        {o.failures.calls.length > 0 && (
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr>
                <th className={th}>Failed calls</th>
                <th className={th}>Model</th>
                <th className={`${th} text-right`}>Calls</th>
              </tr>
            </thead>
            <tbody>
              {o.failures.calls.map((f) => (
                <tr key={`${f.kind} ${f.model}`} className="border-t border-border">
                  <td className={td}>{f.kind}</td>
                  <td className={`${td} text-muted-foreground`}>{f.model}</td>
                  <td className={tdNum}>{f.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {o.failures.latestShown.length > 0 && (
          <ul className="mt-3 space-y-2">
            {o.failures.latestShown.map((e) => (
              <li key={`${e.sessionId} ${e.at}`} className="text-sm">
                <p className="text-destructive">{e.message}</p>
                <SessionLink id={e.sessionId} learner={e.learner} at={e.at} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Homework and exams">
        {o.homework.assignments.length === 0 ? (
          <Empty>None assigned in this period.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={th}>Kind</th>
                <th className={`${th} text-right`}>Assigned</th>
                <th className={`${th} text-right`}>Handed in</th>
                <th className={`${th} text-right`}>Put off</th>
                <th className={`${th} text-right`}>Folded</th>
                <th className={`${th} text-right`}>Open</th>
              </tr>
            </thead>
            <tbody>
              {o.homework.assignments.map((a) => (
                <tr key={a.kind} className="border-t border-border">
                  <td className={td}>{a.kind}</td>
                  <td className={tdNum}>{a.total}</td>
                  <td className={tdNum}>{percent(a.handedIn, a.total)}</td>
                  <td className={tdNum}>{a.putOff}</td>
                  <td className={tdNum}>{a.folded}</td>
                  <td className={tdNum}>{a.open}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {o.homework.reviews.length > 0 && (
          <p className="mt-3 text-sm text-muted-foreground">
            Reviews: {o.homework.reviews.map((r) => `${String(r.count)} ${r.status}`).join(", ")}
          </p>
        )}
      </Section>

      <Section
        title="Calls"
        note="Per purpose: how many, how many failed, how long the successful ones took, and what they cost."
        className="lg:col-span-2"
      >
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className={th}>Purpose</th>
              <th className={`${th} text-right`}>Calls</th>
              <th className={`${th} text-right`}>Failed</th>
              <th className={`${th} text-right`}>Median</th>
              <th className={`${th} text-right`}>90th pct</th>
              <th className={`${th} text-right`}>Cost</th>
            </tr>
          </thead>
          <tbody>
            {o.calls.byPurpose.map((p) => (
              <tr key={p.purpose} className="border-t border-border">
                <td className={td}>{p.purpose}</td>
                <td className={tdNum}>{count(p.calls)}</td>
                <td className={tdNum}>{p.failures}</td>
                <td className={tdNum}>{duration(p.p50Ms)}</td>
                <td className={tdNum}>{duration(p.p90Ms)}</td>
                <td className={tdNum}>{usd(p.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="mt-4 w-full text-sm">
          <thead>
            <tr>
              <th className={th}>Model</th>
              <th className={`${th} text-right`}>Calls</th>
              <th className={`${th} text-right`}>Failed</th>
              <th className={`${th} text-right`}>Cost</th>
            </tr>
          </thead>
          <tbody>
            {o.calls.byModel.map((m) => (
              <tr key={m.model} className="border-t border-border">
                <td className={td}>{m.model}</td>
                <td className={tdNum}>{count(m.calls)}</td>
                <td className={tdNum}>{m.failures}</td>
                <td className={tdNum}>{usd(m.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

function SessionLink({ id, learner, at }: { id: string; learner: number; at: string }) {
  return (
    <Link
      to="/sessions/$id"
      params={{ id }}
      search={{ call: undefined }}
      className="text-xs text-subtle-foreground hover:text-primary"
    >
      {learnerName(learner)} · {when(at)} · open the session
    </Link>
  );
}
