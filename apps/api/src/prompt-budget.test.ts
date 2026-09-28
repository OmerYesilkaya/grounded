import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { initialSession, loadMethod, type SessionState } from "@grounded/core";
import { checkMessages, eq, learningSessions } from "@grounded/db";
import type { JobHelpers } from "graphile-worker";
import { beforeEach, describe, expect, it } from "vitest";
import { estimateTokens, PROMPT_BUDGETS, type BudgetedPhase } from "./engine/prompt-budget.js";
import { createSessionTasks } from "./engine/session-tasks.js";
import { planAttempt, probeGoesOn } from "./test/flows.js";
import { createTestHarness } from "./test/harness.js";
import {
  CONVERSATION,
  createLargeTrack,
  CURRENT_ARC,
  LEFT_OFF,
  termName,
} from "./test/large-track.js";
import { scriptedModels } from "./test/scripted-models.js";

/*
 * Every call of every phase's job, on a large track like the imported one (#13: 204 terms, 34 KB of
 * plan notes, a normal session's chat), must stay within its phase's budget.
 */

const models = scriptedModels();
const t = createTestHarness();
const tasks = createSessionTasks({
  db: t.db,
  models: models.access,
  method: loadMethod(),
  queue: { enqueue: () => Promise.resolve(), close: () => Promise.resolve() },
  files: t.files,
});
const run = async (job: string, payload: object) => {
  // A job may fail after its calls (a state it doesn't expect); only its prompts are measured here.
  await Promise.resolve(tasks[job]?.(payload, {} as JobHelpers)).catch(() => undefined);
};

beforeEach(() => {
  models.reset();
});

const sizeOf = (prompt: LanguageModelV4Prompt) =>
  prompt.reduce(
    (sum, message) =>
      sum +
      (typeof message.content === "string"
        ? message.content.length
        : message.content.reduce((n, part) => n + ("text" in part ? part.text.length : 0), 0)),
    0,
  );

/** The prompt of every call made, by purpose, in characters. */
const promptSizes = () =>
  models.used.flatMap(({ purpose, model }) =>
    [...model.doStreamCalls, ...model.doGenerateCalls].map((call) => ({
      purpose,
      chars: sizeOf(call.prompt),
    })),
  );

const lesson: SessionState = {
  phase: "lesson",
  plan: "approved",
  lesson: { status: "generating", steps: [] },
  steps: {},
  currentStep: null,
};

/** A session of the large track in the given state, and the job that runs its phase. */
const scenarios: Record<
  BudgetedPhase,
  {
    /** The session's state for the job; the large track's session is mid-lesson, on step s1. */
    state?: SessionState;
    setup?: (sessionId: string) => Promise<void>;
    script: () => void;
    job: string;
  }
> = {
  probe: {
    state: initialSession(),
    script: () => {
      models.script("probe-decision", probeGoesOn());
      models.script("probe", { text: "What does the read see meanwhile?" });
    },
    job: "probe-turn",
  },
  plan: {
    state: { ...initialSession(), phase: "plan" },
    script: () => {
      models.script(
        "plan",
        planAttempt("We finish the arc on isolation.", [
          { type: "add-planned-term", term: "snapshot", restsOn: [termName(CURRENT_ARC, 0)] },
        ]),
      );
    },
    job: "plan",
  },
  lesson: {
    state: lesson,
    script: () => {
      models.script("lesson", {
        text: "## Why the read waits\n\nIt waits.\n\n:::check\nWhy?\n:::",
        thenGenerate: [
          JSON.stringify({
            steps: [
              {
                heading: "Why the read waits",
                establishes: "",
                introduces: [],
                restsOn: [],
                check: "Why?",
              },
            ],
          }),
        ],
      });
    },
    job: "lesson",
  },
  check: {
    script: () => {
      models.script("check", {
        thenGenerate: [
          JSON.stringify({
            actions: [],
            verdict: "landed",
            reply: "Yes.",
            freshQuestion: null,
            note: null,
          }),
        ],
      });
    },
    setup: async (sessionId) => {
      await t.db
        .insert(checkMessages)
        .values({ sessionId, stepId: "s1", role: "learner", text: "It would see the old value." });
    },
    job: "check",
  },
  homework: {
    state: { ...lesson, phase: "homework" },
    script: () => {
      models.script("homework", { text: "Predict what the second read shows." });
    },
    job: "homework",
  },
  close: {
    state: { ...lesson, phase: "close" },
    script: () => {
      models.script("close", { text: "We built why a read waits." });
      models.script("term-sweep", { thenGenerate: [JSON.stringify({ actions: [] })] });
      models.script("left-off", { text: LEFT_OFF });
    },
    job: "recap",
  },
};

/** The phase whose budget a call is held to: its prompt is that phase's. */
const PHASE_OF: Record<string, BudgetedPhase> = {
  "probe-decision": "probe",
  "term-sweep": "close",
  "left-off": "close",
};

const withinBudgets = () => {
  const sizes = promptSizes();
  for (const { purpose, chars } of sizes) {
    const phase = PHASE_OF[purpose] ?? (purpose as BudgetedPhase);
    expect(estimateTokens(chars), purpose).toBeLessThanOrEqual(PROMPT_BUDGETS[phase]);
  }
  return [...new Set(sizes.map((s) => s.purpose))];
};

describe("prompt budgets on a large track", () => {
  const purposes: Record<BudgetedPhase, string[]> = {
    probe: ["probe-decision", "probe"],
    plan: ["plan"],
    lesson: ["lesson"],
    check: ["check"],
    homework: ["homework"],
    close: ["close", "term-sweep", "left-off"],
  };
  for (const [phase, scenario] of Object.entries(scenarios)) {
    it(`keeps every call of the ${phase} within ${String(PROMPT_BUDGETS[phase as BudgetedPhase])} tokens`, async () => {
      const { sessionId } = await createLargeTrack(t.db, {
        conversation: CONVERSATION,
        leftOff: LEFT_OFF,
      });
      if (scenario.state)
        await t.db
          .update(learningSessions)
          .set({ state: scenario.state })
          .where(eq(learningSessions.id, sessionId));
      await scenario.setup?.(sessionId);
      scenario.script();
      await run(scenario.job, { sessionId, stepId: "s1" });
      expect(withinBudgets()).toEqual(purposes[phase as BudgetedPhase]);
    });
  }

  it("keeps a just-imported track's opening within budget, its notes read whole only once", async () => {
    const { sessionId } = await createLargeTrack(t.db);
    await t.db
      .update(learningSessions)
      .set({ state: initialSession() })
      .where(eq(learningSessions.id, sessionId));
    models.script("left-off", { text: LEFT_OFF });
    models.script("probe", { text: "What do you remember of isolation levels?" });
    await run("probe-turn", { sessionId });
    expect(withinBudgets()).toEqual(["left-off", "probe"]);
  });
});
