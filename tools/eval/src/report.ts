import { mkdirSync, writeFileSync } from "node:fs";
import { CRITERIA, type CriterionId } from "./judge.js";
import type { RunResult } from "./run.js";

export const RESULTS_DIR = new URL("../results/", import.meta.url);

/** One run's files: the transcript, the full result as JSON, and a readable report. */
export function writeRun(result: RunResult): string {
  const stamp = result.startedAt.replace(/[:.]/g, "-");
  const dir = new URL(
    `${stamp}-${result.persona}-${slug(result.model)}-${slug(result.method)}/`,
    RESULTS_DIR,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL("transcript.md", dir), result.transcript);
  writeFileSync(new URL("result.json", dir), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(new URL("report.md", dir), reportOf(result));
  return dir.pathname;
}

export function reportOf(result: RunResult): string {
  const m = result.metrics;
  const j = result.judgement;
  const lines = [
    `# ${result.persona} · ${result.model} · ${result.method}`,
    "",
    `Started ${result.startedAt}, ${String(result.wallSeconds)} s.${result.error ? ` **Did not close: ${result.error}**` : ""}`,
    "",
  ];
  if (m) {
    lines.push(
      "## Counted",
      "",
      `- Probe: ${String(m.probe.questions)} questions, ${String(m.probe.stacked)} stacked`,
      `- Lesson: ${String(m.lesson.steps)} steps, ${String(m.lesson.checks)} checks, ${String(m.lesson.failedSteps)} failed steps`,
      `- Checks: ${String(m.checks.landedFirstTry)}/${String(m.checks.answered)} landed first try, ${String(m.checks.misses)} misses, ${String(m.checks.settling)} settling or paused, ${String(m.checks.alreadyHeld)} already held`,
      `- Rewrites: ${String(m.rewrites)} · errors shown: ${String(m.errors)} · calls: ${String(m.calls)} (${String(m.failedCalls)} failed)`,
      `- Tokens: ${String(m.tokens.input)} in (${String(m.tokens.cachedInput)} cached), ${String(m.tokens.output)} out · cost: ${m.costUsd === null ? "unknown" : `$${m.costUsd.toFixed(2)}`}`,
      "",
    );
  }
  if (j) {
    lines.push(
      "## Judged",
      "",
      j.summary,
      "",
      "| Criterion | Verdict | Evidence |",
      "|---|---|---|",
    );
    for (const id of Object.keys(CRITERIA) as CriterionId[]) {
      const c = j.criteria.find((x) => x.id === id);
      lines.push(`| ${id} | ${c?.verdict ?? "missing"} | ${cell(c?.evidence ?? "")} |`);
    }
    lines.push(
      "",
      "### Checks",
      "",
      "| Step | Uses the idea | Answerable from the text | Verdict right | Question | Comment |",
      "|---|---|---|---|---|---|",
      ...j.checks.map(
        (c) =>
          `| ${c.step} | ${yes(c.usesTheIdea)} | ${c.answerableFromText ? "**yes**" : "no"} | ${yes(c.verdictRight)} | ${cell(c.question)} | ${cell(c.comment)} |`,
      ),
      "",
      "### Factual errors",
      "",
      ...(j.factualErrors.length
        ? j.factualErrors.map((e) => `- ${e.claim} → ${e.correction}`)
        : ["None found."]),
      "",
    );
  }
  return lines.join("\n");
}

/** One line per run, for the console: the counts that matter and the judge's tally. */
export function summaryLine(result: RunResult): string {
  const m = result.metrics;
  const j = result.judgement;
  const fails = j?.criteria.filter((c) => c.verdict === "fail").map((c) => c.id) ?? [];
  const passes = j?.criteria.filter((c) => c.verdict === "pass").length ?? 0;
  const judged = j
    ? `judge ${String(passes)} pass, ${String(fails.length)} fail${fails.length ? ` (${fails.join(", ")})` : ""}`
    : "not judged";
  const counted = m
    ? `${String(m.probe.questions)} probe q, ${String(m.lesson.checks)}/${String(m.lesson.steps)} checks, ${String(m.checks.landedFirstTry)}/${String(m.checks.answered)} first try, ${String(m.checks.alreadyHeld)} already held, ${m.costUsd === null ? "cost ?" : `$${m.costUsd.toFixed(2)}`}`
    : "no session";
  return `${result.persona} · ${result.model} · ${result.method}: ${result.error ? `DID NOT CLOSE (${result.error}); ` : ""}${counted}; ${judged}`;
}

const slug = (s: string) => s.replace(/[^a-zA-Z0-9.-]+/g, "_").slice(0, 60);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const yes = (b: boolean) => (b ? "yes" : "**no**");
