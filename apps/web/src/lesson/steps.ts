import type { LessonStep } from "@grounded/content";
import { useEffect, useState } from "react";
import { scrollBehavior } from "@/lib/motion";
import type { StepProgress } from "./types";

/** The id of a step's section on the page. */
export const stepAnchor = (stepId: string) => `step-${stepId}`;

/**
 * Steps up to and including the first whose check hasn't landed (or was continued past). A step
 * without a check opens with the step before it.
 */
export function unlockedSteps(
  steps: readonly LessonStep[],
  progress: Record<string, StepProgress | undefined>,
): LessonStep[] {
  const shown: LessonStep[] = [];
  for (const step of steps) {
    shown.push(step);
    const status = progress[step.id]?.status ?? "open";
    if (status !== "passed" && status !== "settling" && status !== "unchecked") break;
  }
  return shown;
}

/** Scrolls the page to a step's start. */
export function jumpToStep(stepId: string): void {
  document
    .getElementById(stepAnchor(stepId))
    ?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
}

/** The step being read: the last one whose top has scrolled past a third of the viewport. */
export function useCurrentStep(shown: readonly LessonStep[]): string | null {
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
