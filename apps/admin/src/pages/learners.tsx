import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Empty, Failed, Loading, td, tdNum, th } from "@/components/ui";
import { adminApi } from "@/lib/api";
import { ago, learnerName, plural, when } from "@/lib/format";

/** The learners by number (design §10.1); an email only when asked for. */
export function LearnersPage() {
  const learners = useQuery({ queryKey: ["learners"], queryFn: adminApi.learners });
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Learners</h1>
        <p className="text-sm text-muted-foreground">
          Named by number, in the order they first signed in.
        </p>
      </div>
      {learners.isPending ? (
        <Loading />
      ) : learners.isError ? (
        <Failed error={learners.error} />
      ) : learners.data.length === 0 ? (
        <Empty>No one has signed in yet.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr>
                <th className={th}>Learner</th>
                <th className={th}>Tracks</th>
                <th className={`${th} text-right`}>Sessions</th>
                <th className={th}>Joined</th>
                <th className={th}>Last call</th>
                <th className={th}>Email</th>
              </tr>
            </thead>
            <tbody>
              {learners.data.map((l) => (
                <tr key={l.learner} className="border-t border-border">
                  <td className={td}>
                    <Link
                      to="/sessions"
                      search={{ learner: l.learner, period: "all" }}
                      className="font-medium hover:text-primary"
                    >
                      {learnerName(l.learner)}
                    </Link>
                  </td>
                  <td className={td}>
                    <ul>
                      {l.tracks.map((t) => (
                        <li key={t.id}>
                          <Link
                            to="/sessions"
                            search={{ track: t.id, period: "all" }}
                            className="hover:text-primary"
                          >
                            {t.title}
                          </Link>{" "}
                          <span className="text-xs text-subtle-foreground">
                            {t.sessions} {plural(t.sessions, "session")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className={tdNum}>{l.sessions}</td>
                  <td className={`${td} whitespace-nowrap`}>{when(l.joinedAt)}</td>
                  <td className={`${td} whitespace-nowrap text-muted-foreground`}>
                    {l.lastActivity ? ago(l.lastActivity) : "–"}
                  </td>
                  <td className={td}>
                    <Email learner={l.learner} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Email({ learner }: { learner: number }) {
  const [asked, setAsked] = useState(false);
  const email = useQuery({
    queryKey: ["email", learner],
    queryFn: () => adminApi.learnerEmail(learner),
    enabled: asked,
  });
  if (!asked)
    return (
      <button
        type="button"
        className="text-xs text-muted-foreground underline hover:text-foreground"
        onClick={() => {
          setAsked(true);
        }}
      >
        Show
      </button>
    );
  return <span className="text-xs">{email.data?.email ?? "…"}</span>;
}
