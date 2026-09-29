import type { LessonStep } from "@grounded/content";
import { useEffect, useRef, type ReactNode } from "react";
import { Blocks } from "@/content/blocks";
import { Inlines } from "@/content/inlines";
import { useMediaQuery } from "@/lib/media-query";
import { AsideLayer } from "./aside-layer";
import { CheckCard } from "./check-card";
import { jumpToStep, stepAnchor, unlockedSteps, useCurrentStep } from "./steps";
import { StepTimeline } from "./step-timeline";
import type { LessonAsides, StepProgress } from "./types";

export type {
  Aside,
  AsideMessage,
  CheckMessage,
  LessonAsides,
  StepProgress,
  StepStatus,
} from "./types";

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
  /** Questions in the margin (design §7.5); without them the lesson takes none. */
  asides?: LessonAsides;
}

/** Wide enough for the margin cards; below it they open as a sheet (design §9.4). */
const WIDE = "(min-width: 1100px)";

const OPEN: StepProgress = { status: "open", thread: [] };

/**
 * The lesson reading view: steps unlock as the checks before them land, a timeline in the left gutter, the
 * reading column centred, and the right margin for aside cards. Controlled: the server decides
 * verdicts and answers; this only shows state and reports what the learner does.
 */
export function LessonView(props: LessonViewProps) {
  const { steps, totalSteps, progress, asides } = props;
  const shown = unlockedSteps(steps, progress);
  const lockedCount = Math.max(0, totalSteps - shown.length);
  const currentStepId = useCurrentStep(shown);
  useScrollToNewStep(shown);
  const grid = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  const margin = useRef<HTMLElement>(null);
  // Where the browser can't tell (tests), the margin is there.
  const wide = useMediaQuery(WIDE, true);

  return (
    <div
      ref={grid}
      className="relative grid grid-cols-[minmax(0,1fr)_minmax(0,68ch)_minmax(340px,1fr)] pt-10 pb-24 max-[1100px]:grid-cols-[minmax(16px,1fr)_minmax(0,68ch)_minmax(16px,1fr)]"
    >
      <div className="flex justify-end pr-10 max-[1100px]:hidden">
        <div className="sticky top-24 w-[210px] self-start">
          <StepTimeline
            steps={shown}
            lockedCount={lockedCount}
            currentStepId={currentStepId}
            progress={progress}
            onJump={jumpToStep}
          />
        </div>
      </div>

      <article
        ref={article}
        className="col-start-2 px-2 font-serif text-[19px] leading-[1.65] max-sm:text-[17.5px]"
      >
        {shown.map((step, index) => {
          const stepProgress = progress[step.id] ?? OPEN;
          return (
            <section
              key={step.id}
              id={stepAnchor(step.id)}
              // Passages are found by their step and block (passages.ts); the heading is the step's
              // first block.
              data-step={step.id}
              className="scroll-mt-20 [&+&]:mt-8 [&+&]:border-t [&+&]:pt-10"
            >
              <h2
                data-block={`${step.id}.b1`}
                className="mb-[0.6em] text-[28px] leading-tight font-semibold tracking-tight"
              >
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

      {/* Right margin: aside cards (design §7.5), laid over it by the aside layer. */}
      <aside
        ref={margin}
        aria-label="Questions"
        className="col-start-3 ml-10 max-w-[300px] max-[1100px]:hidden"
      />
      {asides && (
        <AsideLayer {...asides} grid={grid} lesson={article} margin={margin} wide={wide} />
      )}
    </div>
  );
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
      jumpToStep(target);
    }, 1400);
    return () => {
      window.clearTimeout(timer);
    };
  }, [target]);
}
