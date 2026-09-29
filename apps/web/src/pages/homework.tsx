import { answerProblem, TASK_FORM_SPECS } from "@grounded/core/assignment";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, Check } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Blocks } from "@/content/blocks";
import { ContentProvider } from "@/content/environment";
import { SelfCheck, useSelfCheck } from "@/homework/checklist";
import { TaskFields } from "@/homework/task-fields";
import { useAnswers, type SaveStatus } from "@/homework/use-answers";
import { assignmentApi, useAssignment, type Assignment } from "@/lib/assignments";
import { cn } from "@/lib/utils";

/** The homework page, at /homework/:assignmentId. */
export function HomeworkRoute() {
  const { assignmentId } = useParams({ from: "/app/homework/$assignmentId" });
  const assignment = useAssignment(assignmentId);
  if (!assignment.data) return null;
  // A fresh page for each assignment: its answers start from what that one holds.
  return <HomeworkPage key={assignment.data.id} assignment={assignment.data} />;
}

/** "29 Sep, 14:30": when it was assigned or handed in. */
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * Homework on a page of its own (design §7.4): what it asks, the answer boxes of its kind, what a
 * good answer shows to check against, and handing it in, whole. It can be put off ("Later") while
 * its session waits for it; it stays open in the track list either way.
 */
export function HomeworkPage({ assignment }: { assignment: Assignment }) {
  const queryClient = useQueryClient();
  const { answers, status, error, setError, change, lock, flush } = useAnswers(assignment);
  const [submittedAt, setSubmittedAt] = useState(assignment.submittedAt);
  const [waiting, setWaiting] = useState(assignment.session.waiting);
  const [busy, setBusy] = useState(false);
  const selfCheck = useSelfCheck(assignment.id);
  const handedIn = submittedAt !== null;
  const [task] = assignment.tasks;

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["assignment", assignment.id] }),
      queryClient.invalidateQueries({ queryKey: ["session", assignment.sessionId] }),
      queryClient.invalidateQueries({ queryKey: ["tracks"] }),
    ]);
  };

  const handIn = async () => {
    const problem = assignment.tasks
      .map((t) => answerProblem(t, answers[t.id], { complete: true }))
      .find(Boolean);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      await flush();
      const result = await assignmentApi.submit(assignment.id);
      setSubmittedAt(result.submittedAt);
      setError(null);
      await refresh();
    } catch (failed) {
      setError(failed instanceof Error ? failed.message : "It wasn't handed in. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const later = async () => {
    setBusy(true);
    try {
      await flush();
      await assignmentApi.later(assignment.id);
      setWaiting(false);
      await refresh();
    } catch (failed) {
      setError(failed instanceof Error ? failed.message : "That didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (!task) return null;
  return (
    <ContentProvider>
      <TopBar assignment={assignment} status={handedIn ? null : status} />
      <div className="grid grid-cols-[minmax(16px,1fr)_minmax(0,68ch)_minmax(16px,1fr)] pt-12 pb-28 lg:grid-cols-[minmax(0,1fr)_minmax(0,68ch)_minmax(280px,1fr)]">
        <main className="col-start-2 min-w-0">
          <p className="text-[11px] font-semibold tracking-[0.14em] text-primary uppercase">
            Homework · {TASK_FORM_SPECS[task.form].label}
          </p>
          <h1 className="mt-2 font-serif text-[30px] leading-tight font-semibold tracking-tight text-balance">
            {assignment.title}
          </h1>
          <p className="mt-2 text-[13px] text-subtle-foreground">
            From session {assignment.session.number} of {assignment.trackTitle} · set{" "}
            {when(assignment.createdAt)}
          </p>

          <article className="mt-8 font-serif text-[17px] leading-[1.7] text-foreground">
            <Blocks blocks={task.blocks} />
          </article>

          <div className="mt-6 lg:hidden">
            <SelfCheck
              items={assignment.checklist}
              ticked={selfCheck.ticked}
              onToggle={selfCheck.toggle}
              readOnly={handedIn}
            />
          </div>

          <section aria-label="Your answer" className="mt-10 border-t pt-8">
            <TaskFields
              form={task.form}
              answer={answers[task.id]}
              readOnly={handedIn}
              onChange={(key, value) => {
                change(task.id, key, value);
              }}
              onLock={() => lock(task.id)}
              upload={(file) => assignmentApi.picture(assignment.id, file)}
              onError={setError}
            />
          </section>

          <HandIn
            submittedAt={submittedAt}
            waiting={waiting}
            busy={busy}
            error={error}
            onHandIn={() => void handIn()}
            onLater={() => void later()}
          />
        </main>
        <aside className="col-start-3 ml-10 hidden max-w-[280px] lg:block">
          <div className="sticky top-24">
            <SelfCheck
              items={assignment.checklist}
              ticked={selfCheck.ticked}
              onToggle={selfCheck.toggle}
              readOnly={handedIn}
            />
          </div>
        </aside>
      </div>
    </ContentProvider>
  );
}

const SAVE_WORDS: Record<SaveStatus, string> = {
  saved: "Saved",
  saving: "Saving…",
  failed: "Not saved",
};

/** The page's header band, level with the sidebar's: the way back to its session, and saving. */
function TopBar({ assignment, status }: { assignment: Assignment; status: SaveStatus | null }) {
  return (
    <div className="sticky top-0 z-10 flex h-13 items-center gap-3 border-b bg-background/90 px-4 backdrop-blur">
      <Link
        to="/sessions/$sessionId"
        params={{ sessionId: assignment.sessionId }}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Session {assignment.session.number}
      </Link>
      {status && (
        <span
          role="status"
          className={cn(
            "ml-auto text-[12px] text-subtle-foreground",
            status === "failed" && "text-destructive",
          )}
        >
          {SAVE_WORDS[status]}
        </span>
      )}
    </div>
  );
}

/** Handing it in (whole, never half-done), or putting it off while its session waits. */
function HandIn(props: {
  submittedAt: string | null;
  waiting: boolean;
  busy: boolean;
  error: string | null;
  onHandIn: () => void;
  onLater: () => void;
}) {
  if (props.submittedAt)
    return (
      <div className="mt-12 flex items-center gap-2.5 rounded-xl border bg-card px-4 py-3.5 text-[14px]">
        <span className="flex size-5 items-center justify-center rounded-full bg-success/15 text-success">
          <Check className="size-3.5" strokeWidth={3} aria-hidden />
        </span>
        Handed in {when(props.submittedAt)}.
      </div>
    );
  return (
    <div className="mt-12 border-t pt-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" disabled={props.busy} onClick={props.onHandIn}>
          Hand it in
        </Button>
        {props.waiting && (
          <Button type="button" variant="ghost" disabled={props.busy} onClick={props.onLater}>
            Later
          </Button>
        )}
        <span className="text-[12.5px] text-subtle-foreground">
          {props.waiting
            ? "Later closes the session; the homework stays open in your track."
            : "It stays open in your track until you hand it in."}
        </span>
      </div>
      {props.error && (
        <p role="alert" className="mt-3 text-[13px] text-destructive">
          {props.error}
        </p>
      )}
    </div>
  );
}
