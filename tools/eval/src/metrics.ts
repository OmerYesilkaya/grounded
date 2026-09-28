import { estimateCost } from "@grounded/providers";
import type { RunRecord } from "./record.js";

/** What a run shows without a judge: counted from the database. */
export interface Metrics {
  reachedClose: boolean;
  probe: {
    /** Tutor messages in the probe (questions asked, the opening one included). */
    questions: number;
    /** Probe messages that ask more than one question. */
    stacked: number;
  };
  lesson: {
    steps: number;
    checks: number;
    failedSteps: number;
  };
  checks: {
    answered: number;
    /** Checks whose first verdict landed. */
    landedFirstTry: number;
    misses: number;
    /** Steps continued past while shaky, or paused. */
    settling: number;
    /** Checks where the learner showed they already held what it covered. */
    alreadyHeld: number;
  };
  /** Drafts the app sent back (a chat message or step that broke a rule, a plan that didn't fit, an empty reply). */
  rewrites: number;
  errors: number;
  calls: number;
  failedCalls: number;
  tokens: { input: number; cachedInput: number; output: number };
  /** USD, for the calls whose model has a price; null when none does. */
  costUsd: number | null;
  /** Summed call time, by purpose. */
  secondsByPurpose: Record<string, number>;
}

const REWRITE = /^(Rewriting|Revising|Thinking again)/;

export function metricsOf(record: RunRecord): Metrics {
  const firstPlan = record.messages.findIndex((m) => m.kind === "plan");
  const probe = record.messages
    .slice(0, firstPlan === -1 ? undefined : firstPlan)
    .filter((m) => m.role === "tutor" && m.kind === "message");
  const questionsIn = (text: string) => (text.match(/[?？]/g) ?? []).length;

  const steps = record.state.lesson.steps;
  const answered = steps.filter((s) =>
    record.checks.some((c) => c.stepId === s.id && c.role === "learner"),
  );
  const firstVerdict = (stepId: string) =>
    record.checks.find((c) => c.stepId === stepId && c.verdict !== null)?.verdict;

  let costUsd: number | null = null;
  const seconds: Record<string, number> = {};
  for (const u of record.usage) {
    const cost = estimateCost(u.model, u);
    if (cost !== null) costUsd = (costUsd ?? 0) + cost;
    seconds[u.purpose] = (seconds[u.purpose] ?? 0) + (u.durationMs ?? 0) / 1000;
  }

  return {
    reachedClose: record.state.phase === "closed",
    probe: {
      questions: probe.length,
      stacked: probe.filter((m) => questionsIn(m.text) > 1).length,
    },
    lesson: {
      steps: steps.length,
      checks: steps.filter((s) => s.check).length,
      failedSteps: record.lesson?.failedSteps.length ?? 0,
    },
    checks: {
      answered: answered.length,
      landedFirstTry: answered.filter((s) => firstVerdict(s.id) === "landed").length,
      misses: record.checks.filter((c) => c.verdict === "missed").length,
      settling: Object.values(record.state.steps).filter(
        (s) => s?.status === "settling" || s?.status === "paused",
      ).length,
      alreadyHeld: Object.keys(record.lesson?.alreadyHeld ?? {}).length,
    },
    rewrites: record.activities.filter((label) => REWRITE.test(label)).length,
    errors: record.errors.length,
    calls: record.usage.length,
    failedCalls: record.usage.filter((u) => u.status !== "ok").length,
    tokens: {
      input: sum(record.usage.map((u) => u.inputTokens)),
      cachedInput: sum(record.usage.map((u) => u.cachedInputTokens)),
      output: sum(record.usage.map((u) => u.outputTokens)),
    },
    costUsd,
    secondsByPurpose: Object.fromEntries(
      Object.entries(seconds).map(([k, v]) => [k, Math.round(v * 10) / 10]),
    ),
  };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
