import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ActivityLine } from "@/components/activity-line";
import { ContentProvider } from "@/content/environment";
import { LessonView, type StepProgress } from "@/lesson/lesson-view";
import { api } from "@/lib/api";
import { readableSteps, useSessionModel, type SessionModel } from "@/lib/session";
import { cn } from "@/lib/utils";
import { ChatView } from "./chat-view";
import { LessonAgain } from "./lesson-again";

/** Each step's progress for LessonView, from the session's state, check threads and notes. */
function stepProgress(model: SessionModel): Record<string, StepProgress> {
  const progress: Record<string, StepProgress> = {};
  for (const [stepId, step] of Object.entries(model.state.steps)) {
    if (!step) continue;
    const thread = model.checks.filter((c) => c.stepId === stepId);
    const note = model.lesson?.notes[stepId];
    progress[stepId] = {
      status: step.status,
      offerGate: step.offerGate,
      grading: thread.at(-1)?.role === "learner",
      thread: thread.map((c) =>
        c.role === "learner"
          ? { from: "learner" as const, text: c.text ?? "" }
          : {
              from: "tutor" as const,
              blocks: c.blocks ?? [],
              ...(c.verdict ? { verdict: c.verdict } : {}),
            },
      ),
      ...(note ? { note } : {}),
    };
  }
  return progress;
}

export function SessionPage({ sessionId }: { sessionId: string }) {
  const model = useSessionModel(sessionId);
  const phase = model?.state.phase;
  const queryClient = useQueryClient();
  // The sidebar shows each track's session phase; refresh it when this one moves on.
  useEffect(() => {
    if (phase) void queryClient.invalidateQueries({ queryKey: ["tracks"] });
  }, [phase, queryClient]);
  // The lesson view during the lesson, the chat otherwise, unless the learner switched in this phase.
  const [choice, setChoice] = useState<{ phase: string; tab: "chat" | "lesson" } | null>(null);
  const tab =
    choice !== null && choice.phase === phase ? choice.tab : phase === "lesson" ? "lesson" : "chat";
  const setTab = (next: "chat" | "lesson") => {
    setChoice({ phase: phase ?? "", tab: next });
  };

  const post = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: object }) =>
      api(path, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) }),
  });
  const steps = readableSteps(model?.lesson ?? null);
  const hasLesson = steps.length > 0;

  if (!model) return null;
  const lessonFailed = model.state.phase === "lesson" && model.state.lesson.status === "failed";
  return (
    <ContentProvider>
      <div className="sticky top-0 z-10 flex h-13 items-center justify-center border-b bg-background/90 backdrop-blur">
        <div className="flex gap-0.5 rounded-lg border bg-card p-0.5">
          {(["chat", "lesson"] as const).map((t) => (
            <button
              key={t}
              type="button"
              disabled={t === "lesson" && !hasLesson}
              onClick={() => {
                setTab(t);
              }}
              className={cn(
                "rounded-md px-4 py-1 text-[13px] text-muted-foreground capitalize disabled:opacity-40",
                tab === t && "bg-muted text-foreground",
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      {tab === "chat" || (!model.lesson && !lessonFailed) ? (
        <ChatView
          model={model}
          onOpenLesson={() => {
            setTab("lesson");
          }}
        />
      ) : !hasLesson || !model.lesson ? (
        lessonFailed ? (
          <div className="mx-auto w-full max-w-[68ch] px-6 pt-24">
            <LessonAgain model={model} />
          </div>
        ) : (
          // The outline exists but no step is written yet: say so, rather than an empty timeline.
          <div className="mx-auto w-full max-w-[68ch] px-6 pt-24">
            <h2 className="font-serif text-2xl font-semibold tracking-tight">
              Writing your lesson
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {model.lesson && model.lesson.totalSteps > 0
                ? `${String(model.lesson.totalSteps)} steps are planned. The first one opens as soon as it's written.`
                : "The first step opens as soon as it's written."}
            </p>
            <ActivityLine
              activities={model.activities}
              fallback="Getting started…"
              className="mt-6"
            />
          </div>
        )
      ) : (
        <LessonView
          steps={steps}
          // A failed lesson's missing steps aren't waiting on a check: the notice after the last
          // step says why.
          totalSteps={lessonFailed ? steps.length : model.lesson.totalSteps}
          progress={stepProgress(model)}
          onAnswer={(stepId, text) => {
            post.mutate({
              path: `/api/sessions/${sessionId}/steps/${stepId}/answer`,
              body: { text },
            });
          }}
          onDontKnow={(stepId) => {
            post.mutate({
              path: `/api/sessions/${sessionId}/steps/${stepId}/answer`,
              body: { dontKnow: true },
            });
          }}
          onPause={(stepId) => {
            post.mutate({ path: `/api/sessions/${sessionId}/steps/${stepId}/pause` });
          }}
          onContinue={(stepId) => {
            post.mutate({ path: `/api/sessions/${sessionId}/steps/${stepId}/continue` });
          }}
          after={lessonFailed && <LessonAgain model={model} className="mt-10" />}
        />
      )}
      {tab === "lesson" && hasLesson && model.activities.length > 0 && (
        // Later steps are still being written, or an answer is being checked.
        <div className="fixed bottom-4 left-4 rounded-lg border bg-card/95 px-3 py-2 shadow backdrop-blur md:left-[264px]">
          <ActivityLine activities={model.activities} />
        </div>
      )}
      {model.state.phase === "lesson" &&
        model.state.steps[model.state.currentStep ?? ""]?.status === "paused" && (
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-lg border bg-card px-4 py-2 text-sm shadow">
            Paused here.{" "}
            <button
              type="button"
              className="text-primary underline"
              onClick={() => {
                post.mutate({ path: `/api/sessions/${sessionId}/resume` });
              }}
            >
              Pick it up again
            </button>
          </div>
        )}
    </ContentProvider>
  );
}

/** The route component: one SessionPage per session id, so switching sessions starts fresh. */
export function SessionRoute() {
  const { sessionId } = useParams({ from: "/app/sessions/$sessionId" });
  return <SessionPage key={sessionId} sessionId={sessionId} />;
}
