import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { readableSteps, type SessionModel } from "@/lib/session";
import { cn } from "@/lib/utils";

/**
 * A lesson that failed (design §4.2), and the ways back: "Write the rest again" keeps its outline
 * and the steps written before the first one missing; "Start the lesson over" writes it anew. With
 * no step written, starting over is the only way.
 */
export function LessonAgain({ model, className }: { model: SessionModel; className?: string }) {
  const written = readableSteps(model.lesson).length;
  const gap = model.lesson?.failedSteps.find((f) => f.stepId === `s${String(written + 1)}`);
  const again = useMutation({
    mutationFn: (path: "write-rest" | "start-over") =>
      api(`/api/sessions/${model.id}/lesson/${path}`, { method: "POST" }),
  });
  // Why, where it is known: the job's error, or the step that kept breaking the lesson's rules.
  const reason =
    model.error ??
    (gap
      ? `Step ${String(written + 1)}, “${gap.heading}”, kept breaking the lesson's rules.`
      : null);

  return (
    <div className={cn("rounded-xl border bg-card px-5 py-4 font-sans text-sm", className)}>
      <p className="font-medium">
        {written > 0
          ? "The rest of the lesson couldn't be written."
          : "The lesson couldn't be written."}
      </p>
      {reason && <p className="mt-1 text-muted-foreground">{reason}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {written > 0 ? (
          <>
            <Button
              size="sm"
              disabled={again.isPending}
              onClick={() => {
                again.mutate("write-rest");
              }}
            >
              Write the rest again
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={again.isPending}
              onClick={() => {
                again.mutate("start-over");
              }}
            >
              Start the lesson over
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            disabled={again.isPending}
            onClick={() => {
              again.mutate("start-over");
            }}
          >
            Write the lesson again
          </Button>
        )}
      </div>
      {again.error && <p className="mt-2 text-destructive">{again.error.message}</p>}
    </div>
  );
}
