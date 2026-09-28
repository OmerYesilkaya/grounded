import { describe, expect, it } from "vitest";
import { initialSession, transition, type SessionEvent, type SessionState } from "./index.js";

/** Applies events in order, failing the test on the first rejection. */
function run(state: SessionState, ...events: SessionEvent[]): SessionState {
  return events.reduce((current, event) => {
    const result = transition(current, event);
    if (!result.ok) throw new Error(`rejected ${event.type}: ${result.reason}`);
    return result.state;
  }, state);
}

const rejected = (state: SessionState, event: SessionEvent) => {
  const result = transition(state, event);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.reason;
};

const gate = (id: string) => ({ steps: [id], terms: [], gates: true });
// Every step checked: s1's and s2's checks gate what comes next; s3's is the last, before homework.
const LESSON_STEPS = [
  { id: "s1", check: gate("s1") },
  { id: "s2", check: gate("s2") },
  { id: "s3", check: { steps: ["s3"], terms: [], gates: false } },
];

const inLesson = () =>
  run(
    initialSession(),
    { type: "probe-done" },
    { type: "plan-proposed" },
    { type: "plan-approved" },
    { type: "lesson-ready", steps: LESSON_STEPS },
  );

describe("session phases", () => {
  it("starts in the probe and moves to the plan when probing is done or the learner skips ahead", () => {
    expect(initialSession().phase).toBe("probe");
    expect(run(initialSession(), { type: "probe-done" }).phase).toBe("plan");
    expect(run(initialSession(), { type: "skip-to-plan" }).phase).toBe("plan");
  });

  it("writes no lesson before the plan is proposed and approved", () => {
    const planning = run(initialSession(), { type: "probe-done" });
    expect(rejected(planning, { type: "plan-approved" })).toBe("There is no plan to approve yet.");
    const proposed = run(planning, { type: "plan-proposed" });
    expect(rejected(proposed, { type: "lesson-ready", steps: LESSON_STEPS })).toBe(
      "The plan hasn't been approved.",
    );
    const approved = run(proposed, { type: "plan-approved" });
    expect(approved.phase).toBe("lesson");
    expect(approved.lesson).toEqual({ status: "generating", steps: [] });
  });

  it("sends the plan back for changes when the learner replies to it", () => {
    const proposed = run(initialSession(), { type: "probe-done" }, { type: "plan-proposed" });
    const revising = run(proposed, { type: "learner-message" });
    expect(revising.plan).toBe("revising");
    expect(rejected(revising, { type: "plan-approved" })).toBe("There is no plan to approve yet.");
  });

  it("keeps the chat closed to messages while the lesson is on", () => {
    expect(rejected(inLesson(), { type: "learner-message" })).toBe(
      "Questions during the lesson go in the margin.",
    );
  });

  it("assigns homework only once every check is resolved, then closes", () => {
    const lesson = inLesson();
    expect(rejected(lesson, { type: "checks-complete" })).toBe("Some checks are still open.");
    const done = run(
      lesson,
      { type: "check-verdict", stepId: "s1", verdict: "landed" },
      { type: "check-verdict", stepId: "s2", verdict: "landed" },
      { type: "check-verdict", stepId: "s3", verdict: "landed" },
      { type: "checks-complete" },
    );
    expect(done.phase).toBe("homework");
    expect(run(done, { type: "homework-assigned" }).phase).toBe("close");
    expect(run(done, { type: "homework-assigned" }, { type: "recap-done" }).phase).toBe("closed");
  });

  it("rejects everything once closed", () => {
    const closed: SessionState = { ...initialSession(), phase: "closed" };
    expect(rejected(closed, { type: "learner-message" })).toBe("This session is closed.");
  });
});

describe("checks and the gate", () => {
  it("takes checks in order: only the first open step can be answered", () => {
    expect(rejected(inLesson(), { type: "check-verdict", stepId: "s2", verdict: "landed" })).toBe(
      "Step s2 isn't the step being checked.",
    );
  });

  it("marks a landed check passed and opens the next step", () => {
    const state = run(inLesson(), { type: "check-verdict", stepId: "s1", verdict: "landed" });
    expect(state.steps.s1).toMatchObject({ status: "passed" });
    expect(state.currentStep).toBe("s2");
  });

  it("repairs after the first miss, keeping the step open", () => {
    const state = run(inLesson(), { type: "check-verdict", stepId: "s1", verdict: "missed" });
    expect(state.steps.s1).toEqual({ status: "open", misses: 1, offerGate: false });
    expect(state.currentStep).toBe("s1");
  });

  it("offers pause or continue after a second miss when the next step rests on this one", () => {
    const state = run(
      inLesson(),
      { type: "check-verdict", stepId: "s1", verdict: "missed" },
      { type: "check-verdict", stepId: "s1", verdict: "missed" },
    );
    expect(state.steps.s1).toEqual({ status: "open", misses: 2, offerGate: true });
    expect(rejected(state, { type: "check-verdict", stepId: "s1", verdict: "landed" })).toBe(
      "Choose to pause or continue first.",
    );
  });

  it("opens steps without a check with the step before them, and asks nothing on them", () => {
    const state = run(
      initialSession(),
      { type: "probe-done" },
      { type: "plan-proposed" },
      { type: "plan-approved" },
      {
        type: "lesson-ready",
        steps: [
          { id: "s1", check: null },
          { id: "s2", check: gate("s1") },
          { id: "s3", check: null },
          { id: "s4", check: { steps: ["s3", "s4"], terms: [], gates: false } },
        ],
      },
    );
    expect(state.steps.s1).toMatchObject({ status: "unchecked" });
    expect(state.currentStep).toBe("s2");
    expect(rejected(state, { type: "check-verdict", stepId: "s1", verdict: "landed" })).toBe(
      "Step s1 isn't the step being checked.",
    );
    const next = run(state, { type: "check-verdict", stepId: "s2", verdict: "landed" });
    expect(next.currentStep).toBe("s4");
    const done = run(
      next,
      { type: "check-verdict", stepId: "s4", verdict: "landed" },
      { type: "checks-complete" },
    );
    expect(done.phase).toBe("homework");
  });

  it("continues on its own, marked settling, when nothing in the lesson rests on the check", () => {
    const state = run(
      inLesson(),
      { type: "check-verdict", stepId: "s1", verdict: "landed" },
      { type: "check-verdict", stepId: "s2", verdict: "landed" },
      { type: "check-verdict", stepId: "s3", verdict: "missed" },
      { type: "check-verdict", stepId: "s3", verdict: "missed" },
    );
    expect(state.steps.s3).toEqual({ status: "settling", misses: 2, offerGate: false });
  });

  it("continue anyway marks the step settling and moves on", () => {
    const state = run(
      inLesson(),
      { type: "check-verdict", stepId: "s1", verdict: "missed" },
      { type: "check-verdict", stepId: "s1", verdict: "missed" },
      { type: "continue", stepId: "s1" },
    );
    expect(state.steps.s1).toMatchObject({ status: "settling", offerGate: false });
    expect(state.currentStep).toBe("s2");
  });

  it("pause stops at the step, and resuming reopens it for a fresh question", () => {
    const paused = run(
      inLesson(),
      { type: "check-verdict", stepId: "s1", verdict: "missed" },
      { type: "check-verdict", stepId: "s1", verdict: "missed" },
      { type: "pause", stepId: "s1" },
    );
    expect(paused.steps.s1).toMatchObject({ status: "paused", offerGate: false });
    expect(rejected(paused, { type: "check-verdict", stepId: "s1", verdict: "landed" })).toBe(
      "This step is paused; resume it first.",
    );
    const resumed = run(paused, { type: "resume" });
    expect(resumed.steps.s1).toEqual({ status: "open", misses: 0, offerGate: false });
  });

  it("only allows pause and continue when they were offered", () => {
    expect(rejected(inLesson(), { type: "pause", stepId: "s1" })).toBe(
      "Pausing wasn't offered for this step.",
    );
    expect(rejected(inLesson(), { type: "continue", stepId: "s1" })).toBe(
      "Continuing wasn't offered for this step.",
    );
  });
});

describe("a failed lesson", () => {
  const failed = (...events: SessionEvent[]) =>
    run(inLesson(), ...events, { type: "lesson-failed" });

  it("is written again from its first missing step, keeping where the learner got to before it", () => {
    const state = failed(
      { type: "check-verdict", stepId: "s1", verdict: "landed" },
      { type: "check-verdict", stepId: "s2", verdict: "missed" },
    );
    const resumed = run(state, { type: "lesson-resumed", from: "s2" });
    expect(resumed.lesson).toEqual({ status: "ready", steps: LESSON_STEPS });
    expect(resumed.steps.s1).toMatchObject({ status: "passed" });
    expect(resumed.steps.s2).toEqual({ status: "open", misses: 0, offerGate: false });
    expect(resumed.currentStep).toBe("s2");
  });

  it("is ready again when every step is written", () => {
    expect(run(failed(), { type: "lesson-resumed", from: null }).lesson.status).toBe("ready");
  });

  it("is written again from the start: a new outline, nothing kept", () => {
    const restarted = run(failed({ type: "check-verdict", stepId: "s1", verdict: "landed" }), {
      type: "lesson-restarted",
    });
    expect(restarted).toMatchObject({
      phase: "lesson",
      lesson: { status: "generating", steps: [] },
      steps: {},
      currentStep: null,
    });
  });

  it("is the only lesson that can be written again", () => {
    expect(rejected(inLesson(), { type: "lesson-restarted" })).toBe(
      "Only a lesson that failed can be written again.",
    );
    expect(rejected(inLesson(), { type: "lesson-resumed", from: "s1" })).toBe(
      "Only a lesson that failed can be written again.",
    );
    expect(rejected(failed(), { type: "lesson-resumed", from: "s9" })).toBe(
      "Step s9 isn't in this lesson.",
    );
  });
});
