import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ContentProvider } from "@/content/environment";
import { LessonView, type StepProgress } from "@/lesson/lesson-view";
import { api } from "@/lib/api";
import { useSessionModel, type SessionModel } from "@/lib/session";
import { cn } from "@/lib/utils";
import { ChatView } from "./chat-view";

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
  const hasLesson = (model?.lesson?.steps.length ?? 0) > 0;

  if (!model) return null;
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
      {tab === "chat" || !model.lesson ? (
        <ChatView
          model={model}
          onOpenLesson={() => {
            setTab("lesson");
          }}
        />
      ) : (
        <LessonView
          steps={model.lesson.steps}
          totalSteps={model.lesson.totalSteps}
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
        />
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
