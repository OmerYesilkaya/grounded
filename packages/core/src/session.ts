export type SessionPhase = "probe" | "plan" | "lesson" | "homework" | "close" | "closed";

/** open: waiting for an answer · passed · settling: continued past while shaky · paused. */
export type StepStatus = "open" | "passed" | "settling" | "paused";

export interface StepState {
  status: StepStatus;
  /** Missed answers on this step since it was last opened. */
  misses: number;
  /** Still shaky after a repair, and the next step rests on this one. */
  offerGate: boolean;
}

export interface LessonStepInfo {
  id: string;
  /** Whether this step builds on the one before it (from the outline's term dependencies). */
  restsOnPrevious: boolean;
}

export interface SessionState {
  phase: SessionPhase;
  plan: "none" | "proposed" | "revising" | "approved";
  lesson: { status: "none" | "generating" | "ready" | "failed"; steps: LessonStepInfo[] };
  steps: Record<string, StepState | undefined>;
  /** The first step whose check hasn't been resolved; null when none (or no lesson yet). */
  currentStep: string | null;
}

export type SessionEvent =
  | { type: "learner-message" }
  | { type: "probe-done" }
  | { type: "skip-to-plan" }
  | { type: "plan-proposed" }
  | { type: "plan-approved" }
  | { type: "lesson-ready"; steps: LessonStepInfo[] }
  | { type: "lesson-failed" }
  | { type: "check-verdict"; stepId: string; verdict: "landed" | "missed" }
  | { type: "pause"; stepId: string }
  | { type: "continue"; stepId: string }
  | { type: "resume" }
  | { type: "checks-complete" }
  | { type: "homework-assigned" }
  | { type: "recap-done" };

export type TransitionResult = { ok: true; state: SessionState } | { ok: false; reason: string };

export function initialSession(): SessionState {
  return {
    phase: "probe",
    plan: "none",
    lesson: { status: "none", steps: [] },
    steps: {},
    currentStep: null,
  };
}

const MISSES_BEFORE_GATE = 2;
const resolved = (step: StepState | undefined) =>
  step?.status === "passed" || step?.status === "settling";

/**
 * The session's phase machine (design §7.1). Pure: the server applies an event only if this accepts
 * it, so the method's gates are enforced in one place.
 */
export function transition(state: SessionState, event: SessionEvent): TransitionResult {
  const ok = (next: Partial<SessionState>): TransitionResult => ({
    ok: true,
    state: { ...state, ...next },
  });
  const no = (reason: string): TransitionResult => ({ ok: false, reason });
  if (state.phase === "closed") return no("This session is closed.");

  switch (event.type) {
    case "learner-message":
      if (state.phase === "probe") return ok({});
      if (state.phase === "plan") return ok({ plan: state.plan === "none" ? "none" : "revising" });
      if (state.phase === "lesson") return no("Questions during the lesson go in the margin.");
      return no("The session isn't taking messages now.");

    case "probe-done":
    case "skip-to-plan":
      return state.phase === "probe" ? ok({ phase: "plan" }) : no("The probe is already over.");

    case "plan-proposed":
      return state.phase === "plan"
        ? ok({ plan: "proposed" })
        : no("Plans are proposed during planning.");

    case "plan-approved":
      if (state.phase !== "plan" || state.plan !== "proposed")
        return no("There is no plan to approve yet.");
      return ok({ phase: "lesson", plan: "approved", lesson: { status: "generating", steps: [] } });

    case "lesson-ready": {
      if (state.plan !== "approved" || state.phase !== "lesson")
        return no("The plan hasn't been approved.");
      const steps = Object.fromEntries(
        event.steps.map((s): [string, StepState] => [
          s.id,
          { status: "open", misses: 0, offerGate: false },
        ]),
      );
      return ok({
        lesson: { status: "ready", steps: event.steps },
        steps,
        currentStep: event.steps[0]?.id ?? null,
      });
    }

    case "lesson-failed":
      return state.phase === "lesson"
        ? ok({ lesson: { ...state.lesson, status: "failed" } })
        : no("No lesson is being written.");

    case "check-verdict": {
      const step = state.steps[event.stepId];
      if (state.phase !== "lesson" || !step)
        return no(`Step ${event.stepId} isn't in this lesson.`);
      if (step.status === "paused") return no("This step is paused; resume it first.");
      if (event.stepId !== state.currentStep)
        return no(`Step ${event.stepId} isn't the step being checked.`);
      if (step.offerGate) return no("Choose to pause or continue first.");
      if (event.verdict === "landed")
        return advance(state, event.stepId, { ...step, status: "passed" });
      const misses = step.misses + 1;
      if (misses < MISSES_BEFORE_GATE)
        return ok({ steps: { ...state.steps, [event.stepId]: { ...step, misses } } });
      if (nextRestsOn(state, event.stepId)) {
        return ok({
          steps: { ...state.steps, [event.stepId]: { ...step, misses, offerGate: true } },
        });
      }
      return advance(state, event.stepId, { status: "settling", misses, offerGate: false });
    }

    case "pause": {
      const step = state.steps[event.stepId];
      if (!step?.offerGate) return no("Pausing wasn't offered for this step.");
      return ok({
        steps: { ...state.steps, [event.stepId]: { ...step, status: "paused", offerGate: false } },
      });
    }

    case "continue": {
      const step = state.steps[event.stepId];
      if (!step?.offerGate) return no("Continuing wasn't offered for this step.");
      return advance(state, event.stepId, { ...step, status: "settling", offerGate: false });
    }

    case "resume": {
      const id = state.currentStep;
      const step = id ? state.steps[id] : undefined;
      if (!id || step?.status !== "paused") return no("Nothing is paused.");
      return ok({
        steps: { ...state.steps, [id]: { status: "open", misses: 0, offerGate: false } },
      });
    }

    case "checks-complete":
      if (state.phase !== "lesson" || state.lesson.status !== "ready")
        return no("There is no lesson to finish.");
      if (!state.lesson.steps.every((s) => resolved(state.steps[s.id])))
        return no("Some checks are still open.");
      return ok({ phase: "homework" });

    case "homework-assigned":
      return state.phase === "homework"
        ? ok({ phase: "close" })
        : no("Homework comes after the checks.");

    case "recap-done":
      return state.phase === "close"
        ? ok({ phase: "closed" })
        : no("The recap comes after the homework.");
  }
}

function advance(state: SessionState, stepId: string, step: StepState): TransitionResult {
  const steps = { ...state.steps, [stepId]: step };
  const next = state.lesson.steps.find((s) => !resolved(steps[s.id]));
  return { ok: true, state: { ...state, steps, currentStep: next?.id ?? null } };
}

function nextRestsOn(state: SessionState, stepId: string): boolean {
  const index = state.lesson.steps.findIndex((s) => s.id === stepId);
  return state.lesson.steps[index + 1]?.restsOnPrevious ?? false;
}
