import type { LessonStepInfo } from "@grounded/core";

/** One message of a check thread, as stored. */
export interface ThreadMessage {
  stepId: string;
  role: string;
  text: string | null;
  verdict: string | null;
}

export interface CheckRecordInput {
  steps: readonly LessonStepInfo[];
  headings: readonly string[];
  /** Each step's markdown as written. */
  sources: Readonly<Record<string, string>>;
  /** Every check thread of the lesson, in order. */
  threads: readonly ThreadMessage[];
  notes: Readonly<Record<string, string>>;
  alreadyHeld: Readonly<Record<string, string>>;
}

const CHECK = /:::check\s*\n([\s\S]*?)\n:::\s*$/;

/**
 * What happened at the lesson's checks, for the calls after them (homework, the recap, the term
 * sweep, "where you left off"): each answered check with what it covered, its question, the thread,
 * the note it left, and what the learner showed they already held. Null before any check is answered.
 */
export function checkRecord(input: CheckRecordInput): string | null {
  const entries = input.steps.flatMap((step, index) => {
    const thread = input.threads.filter((m) => m.stepId === step.id);
    if (!step.check || thread.length === 0) return [];
    const covers = step.check.terms.length ? ` — it checks: ${step.check.terms.join(", ")}` : "";
    const question = CHECK.exec(input.sources[step.id] ?? "")?.[1]?.trim();
    const lines = [
      `### The check after step ${String(index + 1)}, "${input.headings[index] ?? ""}"${covers}`,
      ...(question ? [`Question: ${question}`] : []),
      ...thread.map((m) =>
        m.role === "learner"
          ? `Learner: ${m.text ?? ""}`
          : `Tutor${m.verdict ? ` (${m.verdict})` : ""}: ${m.text ?? ""}`,
      ),
    ];
    const note = input.notes[step.id];
    if (note) lines.push(`Where it leaked: ${note}`);
    const held = input.alreadyHeld[step.id];
    if (held) lines.push(`Already held before the lesson taught it: ${held}`);
    return [lines.join("\n")];
  });
  return entries.length ? entries.join("\n\n") : null;
}

/** What the learner showed they already held, earlier in the lesson, for the checks after it. */
export function alreadyHeldSoFar(alreadyHeld: Readonly<Record<string, string>>): string | null {
  const held = Object.values(alreadyHeld);
  return held.length ? held.map((h) => `- ${h}`).join("\n") : null;
}
