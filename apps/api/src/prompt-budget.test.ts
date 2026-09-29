import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { initialFinal, initialSession, loadMethod, type SessionState } from "@grounded/core";
import {
  and,
  assignments,
  checkMessages,
  desc,
  eq,
  isNotNull,
  learningSessions,
  lessons,
  notInArray,
  reviewComments,
  reviewMessages,
  reviews,
  sessionMessages,
  terms,
  tracks,
} from "@grounded/db";
import type { JobHelpers } from "graphile-worker";
import { beforeEach, describe, expect, it } from "vitest";
import { createAsideTasks } from "./engine/aside-tasks.js";
import { createAside, recordAsideMessage } from "./engine/asides.js";
import { estimateTokens, PROMPT_BUDGETS, type BudgetedPhase } from "./engine/prompt-budget.js";
import { createSessionTasks } from "./engine/session-tasks.js";
import { loadSession } from "./engine/session-store.js";
import { HELD_ELSEWHERE_LIMIT } from "./engine/track-state.js";
import { offlineWeb } from "./media/web.js";
import { homework, planAttempt, probeGoesOn } from "./test/flows.js";
import { createTestHarness } from "./test/harness.js";
import {
  CONVERSATION,
  createLargeTrack,
  CURRENT_ARC,
  LEFT_OFF,
  STEP_SOURCE,
  termName,
} from "./test/large-track.js";
import { scriptedModels } from "./test/scripted-models.js";

/*
 * Every call of every phase's job, on a large track like the imported one (#13: 204 terms, 34 KB of
 * plan notes, a normal session's chat), must stay within its phase's budget.
 */

const models = scriptedModels();
const t = createTestHarness();
const deps = {
  db: t.db,
  models: models.access,
  method: loadMethod(),
  queue: { enqueue: () => Promise.resolve(), close: () => Promise.resolve() },
  files: t.files,
  media: { web: offlineWeb },
};
const tasks = { ...createSessionTasks(deps), ...createAsideTasks(deps) };
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

const LESSON_STEPS = ["s1", "s2", "s3", "s4", "s5", "s6"];
const ASIDE_ANCHOR = {
  blockId: "s2.b2",
  quote: "so the read has two choices",
  prefix: "The row is being changed by another transaction, ",
  suffix: ". The row is being changed",
};
const ASIDE_ANSWER =
  "It can wait until the change is finished, or it can read the row as it was before the change began. Which one happens is a setting of the database, and the lesson builds it shortly.";

const COMMENT =
  "Look at what you wrote about the second reader here. What does the row look like to it at the moment the first transaction has changed it but not yet committed, and why?";
const REPLY = "I think it sees the new value, because the change has already been made to the row.";

/**
 * A review of work the last closed session set, done and taken up by `takenUpIn`: `parts` tasks,
 * `items` checklist items (the first leaked), and `comments` open comments, each with a reply and
 * the tutor's answer.
 */
async function reviewedWork(
  last: { id: string; trackId: string; userId: string },
  takenUpIn: string,
  shape: { kind: "homework" | "exam"; parts: number; items: number; comments: number },
) {
  const tasks = Array.from({ length: shape.parts }, (_, i) => ({
    id: `t${String(i + 1)}`,
    title: shape.parts > 1 ? `Part ${String(i + 1)}: two readers and one writer` : null,
    form: "explain" as const,
    blocks: [],
    source: "Explain it.",
  }));
  const checklist = Array.from({ length: shape.items }, (_, i) => ({
    id: `c${String(i + 1)}`,
    text: `Item ${String(i + 1)}: says what the reader sees while the row is changed, and why.`,
  }));
  const [assignment] = await t.db
    .insert(assignments)
    .values({
      trackId: last.trackId,
      userId: last.userId,
      sessionId: last.id,
      kind: shape.kind,
      title: shape.kind === "exam" ? "Readers, writers and isolation" : "The second reader",
      tasks,
      checklist,
      messageId: crypto.randomUUID(),
      submittedAt: new Date(),
    })
    .returning();
  const [review] = await t.db
    .insert(reviews)
    .values({
      assignmentId: assignment?.id ?? "",
      status: "done",
      checklist: checklist.map((item, i) => ({
        id: item.id,
        mark: i === 0 ? ("leaked" as const) : ("held" as const),
        note: i === 0 ? "Look again at what the second reader sees." : "",
      })),
      takenUpIn,
    })
    .returning();
  for (let i = 0; i < shape.comments; i++) {
    const [comment] = await t.db
      .insert(reviewComments)
      .values({
        reviewId: review?.id ?? "",
        position: i,
        anchor: {
          taskId: tasks[i % tasks.length]?.id ?? "t1",
          field: "text",
          quote: "the reader sees the new value",
          prefix: "",
          suffix: "",
        },
        items: ["c1"],
      })
      .returning();
    await t.db.insert(reviewMessages).values(
      [COMMENT, REPLY, COMMENT].map((text, j) => ({
        commentId: comment?.id ?? "",
        role: j % 2 === 0 ? ("tutor" as const) : ("learner" as const),
        text,
      })),
    );
  }
}

/**
 * What waits for the large track's opening review, at its largest: an arc exam's review and a
 * homework's, with open comments in their margins, and two steps the last session went past while
 * still shaky, each with its check thread. The review has had four answers.
 */
async function openingReviewWaiting(sessionId: string) {
  const { trackId } = await loadSession(t.db, sessionId);
  const [last] = await t.db
    .select()
    .from(learningSessions)
    .where(and(eq(learningSessions.trackId, trackId), isNotNull(learningSessions.closedAt)))
    .orderBy(desc(learningSessions.createdAt))
    .limit(1);
  if (!last) throw new Error("no closed session");
  await reviewedWork(last, sessionId, { kind: "exam", parts: 4, items: 6, comments: 8 });
  await reviewedWork(last, sessionId, { kind: "homework", parts: 1, items: 4, comments: 4 });
  const shaky = ["s1", "s2"];
  await t.db
    .update(learningSessions)
    .set({
      state: {
        ...last.state,
        lesson: {
          status: "ready",
          steps: shaky.map((id) => ({ id, check: { steps: [id], terms: [], gates: true } })),
        },
        steps: Object.fromEntries(
          shaky.map((id) => [id, { status: "settling", misses: 2, offerGate: false }]),
        ),
      },
    })
    .where(eq(learningSessions.id, last.id));
  await t.db
    .insert(lessons)
    .values({ sessionId: last.id, stepSources: { s1: STEP_SOURCE, s2: STEP_SOURCE } });
  for (const stepId of shaky)
    await t.db.insert(checkMessages).values(
      [REPLY, COMMENT, REPLY, COMMENT].map((text, i) => ({
        sessionId: last.id,
        stepId,
        role: i % 2 === 0 ? ("learner" as const) : ("tutor" as const),
        text,
      })),
    );
  // The review so far: its opening message and four answers.
  await t.db.delete(sessionMessages).where(eq(sessionMessages.sessionId, sessionId));
  for (let i = 0; i < 8; i++)
    await t.db.insert(sessionMessages).values({
      sessionId,
      role: i % 2 === 0 ? "tutor" : "learner",
      kind: "review",
      text: i % 2 === 0 ? COMMENT : REPLY,
    });
}

/** A session of the large track in the given state, and the job that runs its phase. */
const scenarios: Record<
  BudgetedPhase,
  {
    /** The session's state for the job; the large track's session is mid-lesson, on step s1. */
    state?: SessionState;
    /** Returns more of the job's payload, if it needs any. */
    setup?: (sessionId: string) => Promise<object | undefined>;
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
    // Another track, whose held terms the plan's prompt lists for borrowing (#54): more of them
    // than it lists.
    setup: async (sessionId) => {
      const { userId } = await loadSession(t.db, sessionId);
      const [other] = await t.db
        .insert(tracks)
        .values({ userId, title: "Operating systems", goal: "Operating systems" })
        .returning();
      await t.db.insert(terms).values(
        Array.from({ length: HELD_ELSEWHERE_LIMIT + 50 }, (_, i) => ({
          trackId: other?.id ?? "",
          term: `scheduling idea number ${String(i + 1)}`,
          status: "confirmed" as const,
        })),
      );
      return undefined;
    },
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
            title: "Why the read waits",
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
      // The research before the outline (#53), with a search: its notes reach the outline too.
      models.enableSearch();
      models.script("lesson", {
        searches: ["read committed"],
        text: `NOTES: ${"Under read committed, a read sees only committed rows. ".repeat(20)}`,
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
            alreadyHeld: null,
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
      models.script("homework", homework("Predict what the second read shows."));
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
  review: {
    state: initialSession("review"),
    setup: async (sessionId) => {
      await openingReviewWaiting(sessionId);
      return undefined;
    },
    script: () => {
      models.script("opening-review-decision", {
        thenGenerate: [JSON.stringify({ actions: [], resolved: [], finished: false })],
      });
      models.script("opening-review", { text: "And the second writer: what does it see?" });
    },
    job: "opening-review",
  },
  aside: {
    state: {
      ...lesson,
      lesson: { status: "ready", steps: LESSON_STEPS.map((id) => ({ id, check: null })) },
      steps: Object.fromEntries(
        LESSON_STEPS.map((id) => [id, { status: "unchecked", misses: 0, offerGate: false }]),
      ),
    },
    script: () => {
      models.script("aside", { text: "It waits because the row is still being changed." });
      models.script("aside-record", {
        thenGenerate: [JSON.stringify({ evidence: [], tangent: null })],
      });
    },
    setup: async (sessionId) => {
      // A whole lesson of a real one's size, and two questions already asked on it.
      await t.db
        .update(lessons)
        .set({
          outline: {
            steps: LESSON_STEPS.map((id) => ({
              heading: `Step ${id}`,
              establishes: "",
              introduces: [],
              restsOn: [],
            })),
          },
          stepSources: Object.fromEntries(LESSON_STEPS.map((id) => [id, STEP_SOURCE])),
        })
        .where(eq(lessons.sessionId, sessionId));
      const asked = (question: string) =>
        createAside(t.db, sessionId, { stepId: "s2", anchor: ASIDE_ANCHOR, question });
      for (const question of ["Why two choices?", "What does waiting cost?"]) {
        const { aside } = await asked(question);
        await recordAsideMessage(t.db, sessionId, aside.id, { role: "tutor", text: ASIDE_ANSWER });
      }
      const { aside } = await asked("Why can't the read just go ahead?");
      return { asideId: aside.id };
    },
    job: "aside",
  },
};

/** The phase whose budget a call is held to: its prompt is that phase's. */
const PHASE_OF: Record<string, BudgetedPhase> = {
  "probe-decision": "probe",
  "term-sweep": "close",
  "left-off": "close",
  "aside-record": "aside",
  "opening-review-decision": "review",
  "opening-review": "review",
};

const withinBudgets = () => {
  const sizes = promptSizes();
  for (const { purpose, chars } of sizes) {
    const phase = PHASE_OF[purpose] ?? (purpose as keyof typeof PROMPT_BUDGETS);
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
    review: ["opening-review-decision", "opening-review"],
    aside: ["aside", "aside-record"],
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
      const payload = await scenario.setup?.(sessionId);
      scenario.script();
      await run(scenario.job, { sessionId, stepId: "s1", ...payload });
      expect(withinBudgets()).toEqual(purposes[phase as BudgetedPhase]);
    });
  }

  it("keeps the arc exam within budget, the arc it covers carried whole", async () => {
    const { sessionId } = await createLargeTrack(t.db, {
      conversation: CONVERSATION,
      leftOff: LEFT_OFF,
    });
    await t.db
      .update(learningSessions)
      .set({ state: { ...lesson, phase: "homework" } })
      .where(eq(learningSessions.id, sessionId));
    // The lesson teaches the rest of the current arc, which closes it.
    const rest = Array.from({ length: 8 }, (_, i) => termName(CURRENT_ARC, 9 + i));
    await t.db
      .update(lessons)
      .set({
        outline: {
          title: "Isolation, all of it",
          steps: [{ heading: "The rest", establishes: "", introduces: rest, restsOn: [] }],
        },
      })
      .where(eq(lessons.sessionId, sessionId));
    models.script("homework", homework("Predict what the second read shows."));
    models.script("exam", homework("## Two readers\n\nPredict.\n\n## One writer\n\nExplain."));
    await run("homework", { sessionId });
    expect(withinBudgets()).toEqual(["homework", "exam"]);
  });

  it("keeps the wording review of a message within budget: the whole term list, and the text", async () => {
    const { sessionId } = await createLargeTrack(t.db, {
      conversation: CONVERSATION,
      leftOff: LEFT_OFF,
    });
    await t.db
      .update(learningSessions)
      .set({ state: initialSession() })
      .where(eq(learningSessions.id, sessionId));
    models.script("probe-decision", probeGoesOn());
    models.script("probe", {
      text: "Picture two people reading the same row while a third changes it. In your own words: what does each reader see, and what would you want the map of who waits for whom to look like?",
    });
    await run("probe-turn", { sessionId });
    expect(withinBudgets()).toEqual(["probe-decision", "probe", "wording-review"]);
  });

  it("keeps the final's calls within budget: the whole plan, and in its close the notes", async () => {
    const { sessionId } = await createLargeTrack(t.db, {
      conversation: CONVERSATION,
      leftOff: LEFT_OFF,
    });
    await t.db
      .update(learningSessions)
      .set({ kind: "final" })
      .where(eq(learningSessions.id, sessionId));
    const messages = await t.db
      .select({ id: sessionMessages.id })
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(sessionMessages.createdAt, sessionMessages.id);
    // A normal chat's length for the final's two parts: the audit's answers, short of its most, then
    // the teach-back's. Each part's turn is measured on its own, with what the one before wrote gone.
    const inParts = async (audit: number) => {
      await t.db.delete(sessionMessages).where(
        and(
          eq(sessionMessages.sessionId, sessionId),
          notInArray(
            sessionMessages.id,
            messages.map((m) => m.id),
          ),
        ),
      );
      for (const [i, { id }] of messages.entries())
        await t.db
          .update(sessionMessages)
          .set({ kind: i < audit ? "audit" : "teach-back" })
          .where(eq(sessionMessages.id, id));
    };
    const final = initialFinal(false);
    const inPhase = (phase: SessionState["phase"]) =>
      t.db
        .update(learningSessions)
        .set({ state: { ...final, phase } })
        .where(eq(learningSessions.id, sessionId));

    await inParts(messages.length);
    // The audit takes at most 12 answers, and the conversation has 12: its last exchange goes.
    for (const { id } of messages.splice(-2))
      await t.db.delete(sessionMessages).where(eq(sessionMessages.id, id));
    await inPhase("audit");
    models.script("audit-decision", {
      thenGenerate: [JSON.stringify({ actions: [], finished: false })],
    });
    models.script("audit", { text: "What does the read see meanwhile?" });
    await run("final-turn", { sessionId });

    await inParts(messages.length / 2);
    await inPhase("teach-back");
    models.script("teach-back-decision", {
      thenGenerate: [JSON.stringify({ actions: [], breaks: [], finished: false })],
    });
    models.script("teach-back", { text: "Why does it wait?" });
    await run("final-turn", { sessionId });

    await inPhase("close");
    models.script("close", { text: "Here is where it held." });
    models.script("term-sweep", { thenGenerate: [JSON.stringify({ actions: [] })] });
    models.script("left-off", { text: LEFT_OFF });
    await run("recap", { sessionId });

    const sizes = promptSizes();
    for (const { purpose, chars } of sizes) {
      const closing = ["close", "term-sweep", "left-off"].includes(purpose);
      expect(estimateTokens(chars), purpose).toBeLessThanOrEqual(
        PROMPT_BUDGETS[closing ? "final-close" : "final"],
      );
    }
    expect(new Set(sizes.map((s) => s.purpose))).toEqual(
      new Set([
        "audit-decision",
        "audit",
        "teach-back-decision",
        "teach-back",
        "close",
        "term-sweep",
        "left-off",
      ]),
    );
  });

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
