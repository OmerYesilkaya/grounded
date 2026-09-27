import type { LessonStep } from "@grounded/content";
import { Inlines } from "@/content/inlines";
import { cn } from "@/lib/utils";
import type { StepProgress } from "./types";

export function StepTimeline(props: {
  steps: readonly LessonStep[];
  lockedCount: number;
  currentStepId: string | null;
  progress: Record<string, StepProgress | undefined>;
  onJump: (stepId: string) => void;
}) {
  const { steps, lockedCount, currentStepId, progress, onJump } = props;
  const dot = "absolute top-[9px] -left-[19px] size-[9px] rounded-full border";
  return (
    <nav
      aria-label="Lesson steps"
      className="relative pl-5 font-sans text-[13px] before:absolute before:top-2 before:bottom-2 before:left-[5px] before:w-px before:bg-border-strong"
    >
      <ol>
        {steps.map((step) => {
          const current = step.id === currentStepId;
          const settling = progress[step.id]?.status === "settling";
          return (
            <li key={step.id} className="relative py-[5px]">
              <span
                className={cn(
                  dot,
                  "border-primary bg-primary",
                  current && "bg-background shadow-[0_0_0_3px_var(--highlight)]",
                )}
              />
              <button
                type="button"
                aria-current={current ? "step" : undefined}
                onClick={() => {
                  onJump(step.id);
                }}
                className={cn(
                  "text-left leading-snug text-muted-foreground hover:text-foreground",
                  current && "font-medium text-foreground",
                )}
              >
                <Inlines inlines={step.heading} />
              </button>
              {settling && <span className="ml-1 text-[11.5px] text-primary">· settling</span>}
            </li>
          );
        })}
        {Array.from({ length: lockedCount }, (_, i) => (
          <li
            key={`locked-${String(i)}`}
            aria-label="Locked step"
            className="relative py-[5px] text-subtle-foreground"
          >
            <span className={cn(dot, "border-border-strong bg-background")} />
            <span aria-hidden>·····</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}
