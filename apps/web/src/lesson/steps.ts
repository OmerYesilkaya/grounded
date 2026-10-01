import { answerText, type LessonStep } from "@grounded/content";
import { useEffect, useRef, useState } from "react";
import { scrollBehavior } from "@/lib/motion";
import type { CheckMessage, StepProgress } from "./types";

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

/** A landed verdict stays alone on the page while it is read, at least this long... */
const HOLD_MIN_MS = 1500;
/** ...and at most this long, however much the tutor said. */
const HOLD_MAX_MS = 5000;
/** The moment it takes to see that the check landed, before the words are read. */
const HOLD_BASE_MS = 600;
/** The reading pace the hold assumes: 40 ms a character is about 300 words a minute. */
const HOLD_PER_CHAR_MS = 40;

/** How long a landed verdict of `text` stays alone on the page before the steps it opens arrive. */
export function verdictHold(text: string): number {
  const read = HOLD_BASE_MS + text.length * HOLD_PER_CHAR_MS;
  return Math.min(HOLD_MAX_MS, Math.max(HOLD_MIN_MS, read));
}

const landed = (message: CheckMessage): message is Extract<CheckMessage, { from: "tutor" }> =>
  message.from === "tutor" && message.verdict === "landed";

/** The words of the verdict that landed a check, as they read; "" where there are none. */
function landedVerdictText(progress: StepProgress | undefined): string {
  const message = progress?.thread.findLast(landed);
  return message ? answerText(message.blocks) : "";
}

/**
 * Glides to a step that a check has just opened. Given the step whose verdict landed, the glide
 * stops with that verdict at the top of the window and the new step under it, so what was just read
 * stays in view; otherwise (continued past) the new step's heading is at the top. The window is
 * scrolled to the place itself: the verdict sits in the check's card, which clips its overflow and
 * so is a scroll container of its own, and `scrollIntoView` through one is not reliable.
 */
export function glideToOpenedStep(stepId: string, verdictOf: string | null): void {
  const verdict =
    verdictOf === null
      ? null
      : document.getElementById(stepAnchor(verdictOf))?.querySelector('[data-verdict="landed"]');
  const target = verdict ?? document.getElementById(stepAnchor(stepId));
  if (!target) return;
  const margin = Number.parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
  const top = target.getBoundingClientRect().top + window.scrollY - margin;
  window.scrollTo({ top, behavior: scrollBehavior() });
}

export interface RevealedSteps {
  /** The steps on the page, in order: the unlocked ones, less any still held back. */
  shown: LessonStep[];
  /** The steps that have just arrived, for showing them arrive. */
  arrived: ReadonlySet<string>;
}

interface Arrival {
  ids: string[];
  /** The step the page glides to, and the step whose verdict it keeps in view; null for no glide. */
  glide: { stepId: string; verdictOf: string | null } | null;
}

/**
 * The steps on the page (design §7.3). What the page opens with is on it at once. A step unlocked
 * later by the check before it arrives in its own time: after a landed verdict, once that has been
 * read (`verdictHold`), and the page glides to keep the verdict in view over it; after a check
 * continued past, at once, with a glide to its heading. A step that follows one without a check
 * arrives as it is written, under what the learner is reading, and gets no glide.
 */
export function useRevealedSteps(
  steps: readonly LessonStep[],
  progress: Record<string, StepProgress | undefined>,
): RevealedSteps {
  const unlocked = unlockedSteps(steps, progress);
  const [onPage, setOnPage] = useState(unlocked.length);
  const [arrival, setArrival] = useState<Arrival | null>(null);
  const latest = useRef(unlocked);
  useEffect(() => {
    latest.current = unlocked;
  });

  const count = Math.min(onPage, unlocked.length);
  const next = unlocked[count];
  const gate = count > 0 ? unlocked[count - 1] : undefined;
  const gateStatus = gate?.check ? progress[gate.id]?.status : undefined;
  const gateId = gate?.id ?? null;
  const nextId = next?.id ?? null;
  const hold = gateStatus === "passed" ? verdictHold(landedVerdictText(progress[gateId ?? ""])) : 0;

  useEffect(() => {
    if (nextId === null) return;
    const reveal = () => {
      const all = latest.current;
      setOnPage(all.length);
      setArrival({
        ids: all.slice(count).map((step) => step.id),
        glide:
          gateId !== null && (gateStatus === "passed" || gateStatus === "settling")
            ? { stepId: nextId, verdictOf: gateStatus === "passed" ? gateId : null }
            : null,
      });
    };
    if (hold === 0) {
      reveal();
      return;
    }
    const timer = window.setTimeout(reveal, hold);
    return () => {
      window.clearTimeout(timer);
    };
  }, [count, gateId, gateStatus, hold, nextId]);

  // Once the arrived steps are on the page, the glide: it may stop at the new step's heading.
  useEffect(() => {
    if (arrival?.glide) glideToOpenedStep(arrival.glide.stepId, arrival.glide.verdictOf);
  }, [arrival]);

  return { shown: unlocked.slice(0, count), arrived: new Set(arrival?.ids) };
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
