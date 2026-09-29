export type SessionPhase = "probe" | "plan" | "lesson" | "homework" | "close" | "closed";

/**
 * open: waiting for an answer · passed · settling: continued past while shaky · paused ·
 * unchecked: the step has no check, so it opens with the step before it.
 */
export type StepStatus = "open" | "passed" | "settling" | "paused" | "unchecked";

export interface StepState {
  status: StepStatus;
  /** Missed answers on this step since it was last opened. */
  misses: number;
  /** Still shaky after a repair, and the next step rests on what its check covers. */
  offerGate: boolean;
}

/**
 * A check, placed where the next step needs what came before it (design §7.3): it covers everything
 * taught so far, and not yet checked, that the next step rests on.
 */
export interface StepCheck {
  /** The steps whose ideas it checks, in order; the last is the step it ends. */
  steps: string[];
  /** The lesson's terms it checks (empty for a check made before this was recorded). */
  terms: string[];
  /** A later step rests on it, so an answer still shaky after a repair offers a pause. */
  gates: boolean;
}

export interface LessonStepInfo {
  id: string;
  /** The check the step ends with, or null: a step without one opens with the step before it. */
  check: StepCheck | null;
}

export interface SessionState {
  phase: SessionPhase;
  plan: "none" | "proposed" | "revising" | "approved";
  lesson: { status: "none" | "generating" | "ready" | "failed"; steps: LessonStepInfo[] };
  steps: Record<string, StepState | undefined>;
  /** The first step whose check hasn't been resolved; null when none (or no lesson yet). */
  currentStep: string | null;
  /**
   * The homework phase: being written, then assigned and waiting for the learner to hand it in or
   * put it off, then (handed in) being reviewed, which the close waits for (design §7.4). Missing
   * on a session stored before homework could be handed in.
   */
  homework?: "writing" | "assigned" | "reviewing";
}

export type SessionEvent =
  | { type: "learner-message" }
  | { type: "probe-done" }
  | { type: "skip-to-plan" }
  | { type: "plan-proposed" }
  | { type: "plan-approved" }
  | { type: "lesson-ready"; steps: LessonStepInfo[] }
  | { type: "lesson-failed" }
  /**
   * A failed lesson written again from `from`, the first step not written, on the same outline (null
   * when every step is written). The steps before it stay as they are.
   */
  | { type: "lesson-resumed"; from: string | null }
  /** A failed lesson written again from the start: a new outline, and every step with it. */
  | { type: "lesson-restarted" }
  | { type: "check-verdict"; stepId: string; verdict: "landed" | "missed" }
  | { type: "pause"; stepId: string }
  | { type: "continue"; stepId: string }
  | { type: "resume" }
  | { type: "checks-complete" }
  | { type: "homework-assigned" }
  /** The learner handed the homework in: its review, then the close. */
  | { type: "homework-handed-in" }
  /** The homework's review is done, or failed: the close goes on either way. */
  | { type: "homework-reviewed" }
  /** The learner put the homework off for later: the close. */
  | { type: "homework-later" }
  | { type: "recap-done" };

export type TransitionResult = { ok: true; state: SessionState } | { ok: false; reason: string };

/** The jobs a session can wait on that the learner can't set going again by writing. */
export type AwaitedJob = "probe-turn" | "plan" | "homework" | "review" | "recap";

/**
 * The job the session is waiting on, when the learner can't move it on themselves (design §4.2):
 * the probe's next turn (the opening question, or after the learner's answer), a plan being written
 * or revised, the homework being written or reviewed, the recap. Null when it is the learner's turn (an
 * assigned homework is theirs to hand in or put off), and in the lesson, whose
 * jobs are set going again by answering a check or by writing the lesson again.
 */
export function awaitedJob(
  state: SessionState,
  lastMessage: "learner" | "tutor" | null,
): AwaitedJob | null {
  switch (state.phase) {
    case "probe":
      return lastMessage === "tutor" ? null : "probe-turn";
    case "plan":
      return state.plan === "none" || state.plan === "revising" ? "plan" : null;
    case "homework":
      if (state.homework === "reviewing") return "review";
      return state.homework === "assigned" ? null : "homework";
    case "close":
      return "recap";
    default:
      return null;
  }
}

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

/** Whether the lesson can go past this step: its check landed or was continued past, or it has none. */
export const resolved = (step: StepState | undefined) =>
  step?.status === "passed" || step?.status === "settling" || step?.status === "unchecked";

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
      const steps = Object.fromEntries(event.steps.map((s) => [s.id, unread(s)]));
      return ok({
        lesson: { status: "ready", steps: event.steps },
        steps,
        currentStep: event.steps.find((s) => !resolved(steps[s.id]))?.id ?? null,
      });
    }

    case "lesson-failed":
      return state.phase === "lesson"
        ? ok({ lesson: { ...state.lesson, status: "failed" } })
        : no("No lesson is being written.");

    case "lesson-resumed": {
      if (state.phase !== "lesson" || state.lesson.status !== "failed")
        return no("Only a lesson that failed can be written again.");
      const at =
        event.from === null
          ? state.lesson.steps.length
          : state.lesson.steps.findIndex((s) => s.id === event.from);
      if (at === -1) return no(`Step ${String(event.from)} isn't in this lesson.`);
      // The steps written again start over; the ones before them keep where the learner got to.
      const steps = { ...state.steps };
      for (const s of state.lesson.steps.slice(at)) steps[s.id] = unread(s);
      const lesson = { status: "ready" as const, steps: state.lesson.steps };
      return ok({
        lesson,
        steps,
        currentStep: lesson.steps.find((s) => !resolved(steps[s.id]))?.id ?? null,
      });
    }

    case "lesson-restarted":
      if (state.phase !== "lesson" || state.lesson.status !== "failed")
        return no("Only a lesson that failed can be written again.");
      return ok({ lesson: { status: "generating", steps: [] }, steps: {}, currentStep: null });

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
      if (gates(state, event.stepId)) {
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
      return ok({ phase: "homework", homework: "writing" });

    case "homework-assigned":
      return state.phase === "homework"
        ? ok({ homework: "assigned" })
        : no("Homework comes after the checks.");

    case "homework-handed-in":
      return state.phase === "homework" && state.homework === "assigned"
        ? ok({ homework: "reviewing" })
        : no("There is no homework to hand in yet.");

    case "homework-reviewed":
      return state.phase === "homework" && state.homework === "reviewing"
        ? ok({ phase: "close" })
        : no("There is no homework being reviewed.");

    case "homework-later":
      return state.phase === "homework" && state.homework === "assigned"
        ? ok({ phase: "close" })
        : no("There is no homework to hand in yet.");

    case "recap-done":
      return state.phase === "close"
        ? ok({ phase: "closed" })
        : no("The recap comes after the homework.");
  }
}

/** A step as the learner first meets it: its check open, or opening with the step before it. */
function unread(step: LessonStepInfo): StepState {
  return { status: step.check ? "open" : "unchecked", misses: 0, offerGate: false };
}

function advance(state: SessionState, stepId: string, step: StepState): TransitionResult {
  const steps = { ...state.steps, [stepId]: step };
  const next = state.lesson.steps.find((s) => !resolved(steps[s.id]));
  return { ok: true, state: { ...state, steps, currentStep: next?.id ?? null } };
}

function gates(state: SessionState, stepId: string): boolean {
  return state.lesson.steps.find((s) => s.id === stepId)?.check?.gates ?? false;
}
