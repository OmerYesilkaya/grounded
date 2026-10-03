import type { Replay, ReplayCall, TimelineItem } from "@grounded/core/admin";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { CallPanel } from "@/components/call-panel";
import { Fold, Text } from "@/components/text";
import { Failed, Loading } from "@/components/ui";
import { adminApi } from "@/lib/api";
import { clock, cn, count, duration, learnerName, usd, when } from "@/lib/format";

const route = getRouteApi("/sessions/$id");

/**
 * A session's replay (design §10.1): what the learner saw and did, in time order, with each model
 * call behind it; a call opens in full beside the timeline.
 */
export function SessionPage() {
  const { id } = route.useParams();
  const { call } = route.useSearch();
  const navigate = route.useNavigate();
  const [showCalls, setShowCalls] = useState(true);
  const replay = useQuery({ queryKey: ["session", id], queryFn: () => adminApi.session(id) });
  const openCall = (callId: string | undefined) => {
    void navigate({ search: { call: callId }, replace: true });
  };

  if (replay.isPending) return <Loading />;
  if (replay.isError) return <Failed error={replay.error} />;
  const r = replay.data;
  const items = showCalls ? r.timeline : r.timeline.filter((item) => item.kind !== "call");

  return (
    <div className={cn("grid gap-6", call && "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]")}>
      <div className="min-w-0 space-y-4">
        <Header r={r} />
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={showCalls}
            onChange={(e) => {
              setShowCalls(e.target.checked);
            }}
          />
          Show the model calls between the turns
        </label>
        <ol className="space-y-3">
          {items.map((item, i) => (
            <li key={`${item.kind} ${item.at} ${String(i)}`}>
              <Item item={item} selected={call} onCall={openCall} />
            </li>
          ))}
        </ol>
      </div>
      {call && (
        <aside className="min-w-0 lg:sticky lg:top-16 lg:max-h-[calc(100dvh-5rem)] lg:overflow-y-auto">
          <CallPanel
            id={call}
            onClose={() => {
              openCall(undefined);
            }}
          />
        </aside>
      )}
    </div>
  );
}

function Header({ r }: { r: Replay }) {
  const { session, track, lesson } = r;
  return (
    <header className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold">
          {learnerName(session.learner)} · {track.title}
        </h1>
        <Link
          to="/sessions"
          search={{ learner: session.learner }}
          className="text-xs text-muted-foreground hover:text-primary"
        >
          This learner's sessions
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        {session.kind === "final" ? "The final · " : ""}
        {session.phase} · started {when(session.startedAt)}
        {session.closedAt ? ` · closed ${when(session.closedAt)}` : ""}
        {track.language ? ` · taught in ${track.language}` : ""}
      </p>
      <Fold title="What the learner said they want">
        <Text>{track.goal}</Text>
      </Fold>
      {session.reviewSummary && (
        <Fold title="What the opening review found">
          <Text>{session.reviewSummary}</Text>
        </Fold>
      )}
      {session.probeSummary && (
        <Fold title="What the probe found">
          <Text>{session.probeSummary}</Text>
        </Fold>
      )}
      {session.earlierSummary && (
        <Fold title="Older turns, as summarized for the prompts">
          <Text>{session.earlierSummary}</Text>
        </Fold>
      )}
      {lesson && (
        <div className="flex flex-wrap gap-1.5 text-xs">
          {lesson.steps.map((s) => (
            <span
              key={s.id}
              className={cn(
                "rounded-full border px-2 py-0.5",
                s.status === "passed" && "border-success/60",
                s.status === "settling" && "border-primary",
                s.status === "open" && "border-border-strong",
              )}
            >
              {s.id} {s.status}
              {s.misses > 0 ? ` · ${String(s.misses)} missed` : ""}
            </span>
          ))}
          {lesson.failedSteps.map((s) => (
            <span key={s.stepId} className="rounded-full border border-destructive px-2 py-0.5">
              {s.stepId} not written: {s.heading}
            </span>
          ))}
        </div>
      )}
      {lesson && Object.keys(lesson.alreadyHeld).length > 0 && (
        <Fold title="Already held">
          {Object.entries(lesson.alreadyHeld).map(([step, what]) => (
            <p key={step} className="text-sm">
              <span className="font-mono text-xs text-muted-foreground">{step}</span> {what}
            </p>
          ))}
        </Fold>
      )}
      {lesson && Object.keys(lesson.notes).length > 0 && (
        <Fold title="After-the-check notes">
          {Object.entries(lesson.notes).map(([step, note]) => (
            <p key={step} className="text-sm">
              <span className="font-mono text-xs text-muted-foreground">{step}</span> {note}
            </p>
          ))}
        </Fold>
      )}
    </header>
  );
}

function Item({
  item,
  selected,
  onCall,
}: {
  item: TimelineItem;
  selected: string | undefined;
  onCall: (id: string) => void;
}) {
  switch (item.kind) {
    case "call":
      return <CallRow call={item.call} at={item.at} selected={selected} onCall={onCall} />;
    case "phase":
      return (
        <div className="flex items-center gap-3 py-1 text-xs uppercase tracking-wider text-subtle-foreground">
          <span className="h-px flex-1 bg-border" />
          {item.phase} · {clock(item.at)}
          <span className="h-px flex-1 bg-border" />
        </div>
      );
    case "error":
      return (
        <Card at={item.at} label="Error shown" tone="error">
          <Text>{item.message}</Text>
        </Card>
      );
    case "message":
      return (
        <Card
          at={item.at}
          label={`${item.role === "learner" ? "Learner" : "Tutor"} · ${item.messageKind}`}
          tone={item.role}
        >
          <Text>{item.text}</Text>
        </Card>
      );
    case "outline":
      return (
        <Card at={item.at} label="Lesson outline" tone="tutor">
          {item.title && <p className="font-medium">{item.title}</p>}
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm">
            {item.steps.map((s) => (
              <li key={s.heading}>
                <span className="font-medium">{s.heading}</span>
                <span className="text-muted-foreground"> · {s.establishes}</span>
                {s.introduces.length > 0 && (
                  <span className="text-xs text-subtle-foreground">
                    {" "}
                    · introduces {s.introduces.join(", ")}
                  </span>
                )}
                {s.restsOn.length > 0 && (
                  <span className="text-xs text-subtle-foreground">
                    {" "}
                    · rests on {s.restsOn.join(", ")}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </Card>
      );
    case "step":
      return (
        <Card at={item.at} label={`Lesson step ${item.stepId}`} tone="tutor">
          <p className="font-medium">{item.heading}</p>
          <Fold title="The step as shown" open>
            <Text>{item.text}</Text>
          </Fold>
          {item.source && (
            <Fold title="As the model wrote it">
              <Text mono>{item.source}</Text>
            </Fold>
          )}
        </Card>
      );
    case "check":
      return (
        <Card
          at={item.at}
          label={`Check ${item.stepId} · ${item.role === "learner" ? "learner" : "tutor"}`}
          tone={item.role}
          badge={
            item.verdict && (
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs",
                  item.verdict === "landed"
                    ? "bg-success/15 text-success"
                    : "bg-destructive/15 text-destructive",
                )}
              >
                {item.verdict}
              </span>
            )
          }
        >
          <Text>{item.text}</Text>
          {item.failure && <p className="mt-1 text-xs text-destructive">{item.failure}</p>}
        </Card>
      );
    case "aside":
      return (
        <Card at={item.at} label={`Aside on ${item.stepId}`} tone="learner">
          <blockquote className="border-l-2 border-primary/60 pl-2 text-sm text-muted-foreground">
            {item.quote}
          </blockquote>
          <div className="mt-2 space-y-2">
            {item.thread.map((m, i) => (
              <div
                key={String(i)}
                className={cn(m.role === "tutor" && "border-l border-border pl-3")}
              >
                <div className="text-xs text-subtle-foreground">
                  {m.role === "learner" ? "Learner" : "Tutor"}
                </div>
                <Text>{m.text}</Text>
                {m.failure && <p className="text-xs text-destructive">{m.failure}</p>}
              </div>
            ))}
          </div>
          {item.tangent && (
            <p className="mt-2 text-xs text-muted-foreground">Tangent offered: {item.tangent}</p>
          )}
        </Card>
      );
    case "research":
      return (
        <Card at={item.at} label={`Research for the ${item.for}`} tone="tutor">
          <p className="text-xs text-muted-foreground">
            {item.searches.length} searches · {item.sources} pages
          </p>
          {item.searches.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-sm">
              {item.searches.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          )}
          <Fold title="Notes">
            <Text>{item.notes}</Text>
          </Fold>
        </Card>
      );
    case "assignment":
      return (
        <Card at={item.at} label={item.assignmentKind} tone="tutor">
          <p className="font-medium">{item.title}</p>
          <p className="text-xs text-muted-foreground">
            {item.submittedAt
              ? `handed in ${when(item.submittedAt)}`
              : item.folded
                ? "folded into a later homework"
                : item.snoozedUntil
                  ? `put off until ${when(item.snoozedUntil)}`
                  : "not handed in"}
          </p>
          <Fold title={`Tasks (${String(item.tasks.length)})`}>
            {item.tasks.map((task, i) => (
              <Text key={String(i)}>{task}</Text>
            ))}
          </Fold>
          <Fold title="What a good answer demonstrates">
            <ul className="list-disc pl-5 text-sm">
              {item.checklist.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </Fold>
          {item.review && (
            <Fold title={`Review · ${item.review.status}`} open>
              <ul className="space-y-1 text-sm">
                {item.review.marks.map((m) => (
                  <li key={m.item}>
                    <span className="font-mono text-xs">{m.item}</span>{" "}
                    <span
                      className={cn(
                        m.mark === "held" ? "text-success" : "text-destructive",
                        "font-medium",
                      )}
                    >
                      {m.mark}
                    </span>{" "}
                    <span className="text-muted-foreground">{m.note}</span>
                  </li>
                ))}
              </ul>
              {item.review.comments.map((c, i) => (
                <div key={String(i)} className="mt-2">
                  <blockquote className="border-l-2 border-primary/60 pl-2 text-sm text-muted-foreground">
                    {c.quote}
                  </blockquote>
                  {c.thread.map((m, j) => (
                    <div key={String(j)} className="mt-1 text-sm">
                      <span className="text-xs text-subtle-foreground">{m.role}: </span>
                      {m.text}
                    </div>
                  ))}
                </div>
              ))}
            </Fold>
          )}
        </Card>
      );
  }
}

function CallRow({
  call,
  at,
  selected,
  onCall,
}: {
  call: ReplayCall;
  at: string;
  selected: string | undefined;
  onCall: (id: string) => void;
}) {
  const issues = call.verdict?.issues.length ?? 0;
  return (
    <button
      type="button"
      onClick={() => {
        onCall(call.id);
      }}
      className={cn(
        "ml-6 flex w-[calc(100%-1.5rem)] flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md border border-dashed border-border px-3 py-1.5 text-left font-mono text-xs text-muted-foreground hover:border-primary",
        selected === call.id && "border-solid border-primary bg-highlight",
      )}
    >
      <span className="text-foreground">{call.purpose}</span>
      <span>{call.model}</span>
      <span>{clock(at)}</span>
      <span>{duration(call.durationMs)}</span>
      <span>
        {count(call.inputTokens)} in · {count(call.outputTokens)} out
      </span>
      <span>{usd(call.costUsd)}</span>
      {call.verdict && call.verdict.rewrite > 0 && (
        <span className="text-primary">rewrite {call.verdict.rewrite}</span>
      )}
      {issues > 0 && (
        <span className="text-destructive">
          {issues} issue{issues === 1 ? "" : "s"}
        </span>
      )}
      {call.status === "error" && (
        <span className="text-destructive">failed: {call.errorKind ?? "unknown"}</span>
      )}
      {!call.stored && <span>content not kept</span>}
    </button>
  );
}

function Card({
  at,
  label,
  tone,
  badge,
  children,
}: {
  at: string;
  label: string;
  tone: "learner" | "tutor" | "error";
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        tone === "learner" && "border-primary/40 bg-highlight",
        tone === "tutor" && "border-border bg-card",
        tone === "error" && "border-destructive/60",
      )}
    >
      <div className="mb-1 flex items-center justify-between gap-2 text-xs text-subtle-foreground">
        <span>{label}</span>
        <span className="flex items-center gap-2">
          {badge}
          {clock(at)}
        </span>
      </div>
      {children}
    </div>
  );
}
