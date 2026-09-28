import { describe, expect, it } from "vitest";
import { TASKS, type Learner } from "./learner.js";
import { loadPersona, personaIds } from "./persona.js";
import { runEval } from "./run.js";

const SERVER_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://grounded:grounded@localhost:5432/grounded_test";

/** A learner that approves every plan and gives the same answer to everything else. */
const scripted = (): Learner & { tasks: string[] } => {
  const tasks: string[] = [];
  return {
    tasks,
    reply: (_seen, task) => {
      tasks.push(task);
      return Promise.resolve(
        task === TASKS.plan ? "APPROVE" : "It copies the value out, adds one and puts it back.",
      );
    },
  };
};

describe("an eval run", () => {
  it("drives a whole session through the real app, then counts it and writes its transcript", async () => {
    const learner = scripted();
    const result = await runEval({
      persona: loadPersona("cold-networking"),
      candidate: { kind: "demo" },
      learner,
      serverUrl: SERVER_URL,
    });

    expect(result.error).toBeNull();
    expect(result.metrics).toMatchObject({
      reachedClose: true,
      probe: { questions: 1, stacked: 0 },
      lesson: { steps: 3, checks: 3, failedSteps: 0 },
      // The demo misses its second check once, then lands it.
      checks: { answered: 3, landedFirstTry: 2, misses: 1, alreadyHeld: 0 },
      errors: 0,
    });
    expect(learner.tasks).toEqual([
      TASKS.chat,
      TASKS.plan,
      TASKS.check,
      TASKS.check,
      TASKS.check,
      TASKS.check,
    ]);
    expect(result.transcript).toContain("## What the probe found (hidden from the learner)");
    expect(result.transcript).toContain("Check thread:");
    expect(result.transcript).toContain("## Recap (chat)");
    expect(result.judgement).toBeNull();
  });
});

describe("personas", () => {
  it("each have a goal and a language", () => {
    expect(personaIds().length).toBeGreaterThanOrEqual(4);
    for (const id of personaIds()) expect(loadPersona(id).goal).not.toBe("");
  });
});
