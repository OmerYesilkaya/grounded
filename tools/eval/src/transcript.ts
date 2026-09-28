import type { RunRecord } from "./record.js";

/**
 * The whole session as the judge reads it (and as a person reviewing a run does): the chat, what the
 * app kept hidden from the learner (the probe's summary, the plan's record, where the checks were
 * placed), each lesson step with its check thread, and the terms at the end.
 */
export function transcriptOf(record: RunRecord): string {
  const out: string[] = [`# Session transcript`, "", `Goal as typed: ${record.goal}`, ""];
  const chat = (kinds: string[]) =>
    record.messages
      .filter((m) => kinds.includes(m.kind))
      .map((m) => `**${m.role === "tutor" ? "Tutor" : "Learner"}** (${m.kind}):\n\n${m.text}`)
      .join("\n\n");

  out.push("## Probe (chat)", "", chat(["message"]) || "(none)", "");
  out.push(
    "## What the probe found (hidden from the learner)",
    "",
    record.probeSummary ?? "(none)",
    "",
  );
  out.push("## Plan (chat)", "", chat(["plan"]) || "(none)", "");
  out.push(
    "## Plan as recorded (hidden)",
    "",
    ...record.plan.arcs.map((a) => `- ${a.title}: ${a.terms.join(", ")}`),
    "",
    `Notes: ${record.plan.notes || "(none)"}`,
    "",
  );

  out.push("## Lesson", "");
  const steps = record.state.lesson.steps;
  if (!record.lesson || steps.length === 0) out.push("(no lesson)", "");
  steps.forEach((info, index) => {
    const outline = record.lesson?.outline?.steps[index];
    const check = info.check
      ? `ends with a check on ${info.check.terms.join(", ") || "its own idea"} (covering ${info.check.steps.join(", ")}${info.check.gates ? "; the next step rests on it" : "; the last check"})`
      : "no check (nothing ahead rests on it yet)";
    out.push(
      `### Step ${String(index + 1)} (${info.id}) — ${check}`,
      "",
      outline
        ? `_Outline: introduces ${outline.introduces.join(", ") || "nothing"}; rests on ${outline.restsOn.join(", ") || "nothing"}._`
        : "",
      "",
      record.lesson?.sources[info.id] ?? "(not written)",
      "",
    );
    const thread = record.checks.filter((c) => c.stepId === info.id);
    if (thread.length) {
      out.push(
        "Check thread:",
        "",
        ...thread.map(
          (m) =>
            `- ${m.role === "learner" ? "Learner" : `Tutor${m.verdict ? ` (${m.verdict})` : ""}`}: ${m.text}`,
        ),
        "",
      );
    }
    const note = record.lesson?.notes[info.id];
    if (note) out.push(`After the check (note): ${note}`, "");
    const held = record.lesson?.alreadyHeld[info.id];
    if (held) out.push(`Recorded as already held: ${held}`, "");
    const status = record.state.steps[info.id]?.status;
    if (status && status !== "passed" && status !== "unchecked") out.push(`Status: ${status}`, "");
  });

  out.push("## Homework (chat)", "", chat(["homework"]) || "(none)", "");
  out.push("## Recap (chat)", "", chat(["recap"]) || "(none)", "");
  out.push("## Where you left off (hidden)", "", record.leftOff ?? "(none)", "");
  out.push("## Terms at the end", "", ...record.terms.map((t) => `- ${t.term}: ${t.status}`), "");
  if (record.errors.length) out.push("## Errors shown", "", ...record.errors.map((e) => `- ${e}`));
  return out.join("\n");
}
