import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { FilterBar } from "@/components/filter-bar";
import { Empty, Failed, Loading, td, tdNum, th } from "@/components/ui";
import { adminApi, queryString } from "@/lib/api";
import type { SessionSearch } from "@/lib/filters";
import { ago, cn, learnerName, percent, usd, when } from "@/lib/format";

const route = getRouteApi("/sessions");

/** What each narrowing of the list says, as a removable chip. */
const NARROWING: Record<"learner" | "track" | "issue" | "has" | "phase", string> = {
  learner: "learner",
  track: "track",
  issue: "issue",
  has: "with",
  phase: "phase",
};

/** The sessions (design §10.1): newest first, each with what went wrong in it. */
export function SessionsPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const sessions = useQuery({
    queryKey: ["sessions", search],
    queryFn: () => adminApi.sessions(queryString({ ...search })),
  });
  const set = (next: SessionSearch) => {
    void navigate({ search: { ...next, before: undefined } });
  };
  const chips = (Object.keys(NARROWING) as (keyof typeof NARROWING)[]).filter(
    (key) => search[key] !== undefined,
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold">Sessions</h1>
        <FilterBar
          filters={search}
          onChange={(next) => {
            set({ ...search, ...next });
          }}
        />
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {chips.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                set({ ...search, [key]: undefined });
              }}
              className="inline-flex items-center gap-1 rounded-full border border-border-strong px-2.5 py-0.5 text-xs hover:border-primary"
            >
              {NARROWING[key]}:{" "}
              {key === "learner" ? learnerName(search.learner ?? 0) : String(search[key])}
              <X className="size-3" aria-label="remove" />
            </button>
          ))}
        </div>
      )}
      {sessions.isPending ? (
        <Loading />
      ) : sessions.isError ? (
        <Failed error={sessions.error} />
      ) : sessions.data.sessions.length === 0 ? (
        <Empty>No sessions match.</Empty>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full min-w-[56rem] text-sm">
              <thead>
                <tr>
                  <th className={th}>Learner · track</th>
                  <th className={th}>Phase</th>
                  <th className={th}>Started</th>
                  <th className={th}>Last activity</th>
                  <th className={`${th} text-right`}>Checks first try</th>
                  <th className={`${th} text-right`}>Misses</th>
                  <th className={`${th} text-right`}>Asides</th>
                  <th className={`${th} text-right`}>Rewrites</th>
                  <th className={`${th} text-right`}>Errors</th>
                  <th className={`${th} text-right`}>Calls</th>
                  <th className={`${th} text-right`}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {sessions.data.sessions.map((s) => {
                  const errors = s.errors + s.failedCalls;
                  return (
                    <tr key={s.id} className="border-t border-border hover:bg-highlight">
                      <td className={td}>
                        <Link
                          to="/sessions/$id"
                          params={{ id: s.id }}
                          search={{ call: undefined }}
                          className="font-medium hover:text-primary"
                        >
                          {learnerName(s.learner)} · {s.trackTitle}
                        </Link>
                        <div className="text-xs text-subtle-foreground">
                          {s.kind === "final" ? "final · " : ""}
                          {s.models.join(", ") || "no calls"}
                        </div>
                      </td>
                      <td className={td}>{s.phase}</td>
                      <td className={`${td} whitespace-nowrap`}>{when(s.startedAt)}</td>
                      <td className={`${td} whitespace-nowrap text-muted-foreground`}>
                        {ago(s.lastActivity)}
                      </td>
                      <td className={tdNum}>
                        {s.checked === 0
                          ? "–"
                          : `${percent(s.firstTry, s.checked)} of ${String(s.checked)}`}
                      </td>
                      <td className={tdNum}>{s.misses || ""}</td>
                      <td className={tdNum}>{s.asides || ""}</td>
                      <td className={tdNum}>{s.rewrites || ""}</td>
                      <td className={cn(tdNum, errors > 0 && "text-destructive")}>
                        {errors || ""}
                      </td>
                      <td className={tdNum}>{s.calls}</td>
                      <td className={tdNum}>{usd(s.costUsd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {sessions.data.next && (
            <button
              type="button"
              className="rounded-md border border-border-strong px-3 py-1.5 text-sm hover:border-primary"
              onClick={() => {
                void navigate({ search: { ...search, before: sessions.data.next ?? undefined } });
              }}
            >
              Older sessions
            </button>
          )}
        </>
      )}
    </div>
  );
}
