import type { LessonStep } from "@grounded/content";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Blocks } from "@/content/blocks";
import { Inlines } from "@/content/inlines";
import { scrollBehavior } from "@/lib/motion";
import { CheckCard } from "./check-card";
import { StepTimeline } from "./step-timeline";
import type { StepProgress } from "./types";

export type { CheckMessage, StepProgress, StepStatus } from "./types";

export interface LessonViewProps {
  steps: readonly LessonStep[];
  /** Steps in the outline, including ones not written or not yet unlocked. */
  totalSteps: number;
  progress: Record<string, StepProgress | undefined>;
  onAnswer: (stepId: string, text: string) => void;
  onDontKnow: (stepId: string) => void;
  onPause: (stepId: string) => void;
  onContinue: (stepId: string) => void;
  /** What follows the last step shown, in the reading column (a failed lesson's way back). */
  after?: ReactNode;
}

const OPEN: StepProgress = { status: "open", thread: [] };
const stepAnchor = (stepId: string) => `step-${stepId}`;

/**
 * Steps up to and including the first whose check hasn't landed (or was continued past). A step
 * without a check opens with the step before it.
 */
function unlockedSteps(
  steps: readonly LessonStep[],
  progress: LessonViewProps["progress"],
): LessonStep[] {
  const shown: LessonStep[] = [];
  for (const step of steps) {
    shown.push(step);
    const status = progress[step.id]?.status ?? "open";
    if (status !== "passed" && status !== "settling" && status !== "unchecked") break;
  }
  return shown;
}

/**
 * The lesson reading view: steps unlock as the checks before them land, a timeline in the left gutter, the
 * reading column centred, and the right margin reserved for aside cards. Controlled: the server
 * decides verdicts; this only shows state and reports what the learner does.
 */
export function LessonView(props: LessonViewProps) {
  const { steps, totalSteps, progress } = props;
  const shown = unlockedSteps(steps, progress);
  const lockedCount = Math.max(0, totalSteps - shown.length);
  const currentStepId = useCurrentStep(shown);
  useScrollToNewStep(shown);

  const jump = (stepId: string) => {
    document
      .getElementById(stepAnchor(stepId))
      ?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,68ch)_minmax(340px,1fr)] pt-10 pb-24 max-[1100px]:grid-cols-[minmax(16px,1fr)_minmax(0,68ch)_minmax(16px,1fr)]">
      <div className="flex justify-end pr-10 max-[1100px]:hidden">
        <div className="sticky top-24 w-[210px] self-start">
          <StepTimeline
            steps={shown}
            lockedCount={lockedCount}
            currentStepId={currentStepId}
            progress={progress}
            onJump={jump}
          />
        </div>
      </div>

      <article className="col-start-2 px-2 font-serif text-[19px] leading-[1.65] max-sm:text-[17.5px]">
        {shown.map((step, index) => {
          const stepProgress = progress[step.id] ?? OPEN;
          return (
            <section
              key={step.id}
              id={stepAnchor(step.id)}
              className="scroll-mt-20 [&+&]:mt-8 [&+&]:border-t [&+&]:pt-10"
            >
              <h2 className="mb-[0.6em] text-[28px] leading-tight font-semibold tracking-tight">
                <Inlines inlines={step.heading} />
              </h2>
              {stepProgress.status === "settling" && (
                <p className="-mt-2 mb-3 font-sans text-xs tracking-wider text-primary uppercase">
                  Still settling
                </p>
              )}
              <Blocks blocks={step.body} />
              {stepProgress.note && (
                <div className="my-4 rounded-r-lg border-l-3 border-primary bg-highlight px-3.5 py-2.5 font-sans text-sm">
                  <b className="mb-0.5 block text-[11.5px] tracking-wider text-primary uppercase">
                    After the check
                  </b>
                  {stepProgress.note}
                </div>
              )}
              {step.check && (
                <CheckCard
                  check={step.check}
                  progress={stepProgress}
                  onAnswer={(text) => {
                    props.onAnswer(step.id, text);
                  }}
                  onDontKnow={() => {
                    props.onDontKnow(step.id);
                  }}
                  onPause={() => {
                    props.onPause(step.id);
                  }}
                  onContinue={() => {
                    props.onContinue(step.id);
                  }}
                />
              )}
              {index === shown.length - 1 && lockedCount > 0 && (
                <p className="my-8 rounded-xl border border-dashed border-border-strong p-5 text-center font-sans text-sm text-subtle-foreground">
                  {lockedCount} more {lockedCount === 1 ? "step" : "steps"} · each opens when the
                  check before it lands
                </p>
              )}
            </section>
          );
        })}
        {props.after}
      </article>

      {/* Right margin: aside cards (design §7.5). */}
      <aside
        aria-label="Questions"
        className="col-start-3 ml-10 max-w-[300px] max-[1100px]:hidden"
      />
    </div>
  );
}

/** The step being read: the last one whose top has scrolled past a third of the viewport. */
function useCurrentStep(shown: readonly LessonStep[]): string | null {
  const lastId = shown.at(-1)?.id ?? null;
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    const update = () => {
      let id: string | null = shown[0]?.id ?? null;
      for (const step of shown) {
        const top = document.getElementById(stepAnchor(step.id))?.getBoundingClientRect().top;
        if (top !== undefined && top < window.innerHeight * 0.35) id = step.id;
      }
      setCurrent(id);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      window.removeEventListener("scroll", update);
    };
  }, [shown, lastId]);
  return current;
}

/**
 * When a check lands and steps open, glide to the first of them once the verdict has been read. The
 * glide goes to the latest step opened by a check; a step that follows one without a check arrives
 * as it is written, under what the learner is reading, and gets no glide.
 */
function useScrollToNewStep(shown: readonly LessonStep[]): void {
  const target = shown.findLast((_, i) => Boolean(shown[i - 1]?.check))?.id ?? null;
  const seen = useRef(target);
  useEffect(() => {
    if (!target || target === seen.current) return;
    seen.current = target;
    const timer = window.setTimeout(() => {
      document
        .getElementById(stepAnchor(target))
        ?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
    }, 1400);
    return () => {
      window.clearTimeout(timer);
    };
  }, [target]);
}
