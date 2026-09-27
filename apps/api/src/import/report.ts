import type { ImportOutcome, ImportReport } from "./import-track.js";

const count = (n: number) => n.toLocaleString("en-US");

/** The import's outcome as the CLI prints it. */
export function formatOutcome(outcome: ImportOutcome): string {
  switch (outcome.status) {
    case "refused":
      return `Refused: ${outcome.reason}\nNothing was written.`;
    case "rejected":
      return [
        `The model's edits were still rejected after ${String(outcome.attempts)} attempts. Nothing was written.`,
        ...outcome.errors.map((e) => `  - ${e}`),
      ].join("\n");
    case "ok":
      return formatReport(outcome.report);
  }
}

export function formatReport(r: ImportReport): string {
  const c = r.termCounts;
  const total = c.assumed + c.confirmed + c.taught + c.planned;
  const lines = [
    r.written
      ? `Imported ${r.folder} (track ${r.trackId ?? ""})`
      : `Dry run of ${r.folder}: nothing written. Add --write to apply it.`,
    "",
    `Learner        ${r.email}`,
    `Track          ${r.title}${r.language ? ` (taught in ${r.language})` : ""}`,
    `Terms          ${count(total)}: ${count(c.assumed)} assumed · ${count(c.confirmed)} confirmed · ${count(c.taught)} taught · ${count(c.planned)} planned`,
    `Dependencies   ${count(r.dependencies)} "rests on" edges`,
    `Arcs           ${String(r.arcs.length)}`,
    ...r.arcs.map((a, i) => `  ${String(i + 1)}. ${a.title} (${count(a.terms)} terms)`),
    `Fix-list       ${String(r.fixItems.length)} open`,
    ...r.fixItems.map((f) => `  - ${f}`),
    `Plan notes     ${count(r.notesLength)} characters`,
    `Last lesson    ${r.latestLesson ? `${r.latestLesson.folder}: "${r.latestLesson.title}" (${count(r.latestLesson.length)} characters of HTML, stored read-only)` : "none found"}`,
    `Owed homework  ${r.owedHomework ? `${r.owedHomework.folder}/homework.md (${count(r.owedHomework.length)} characters, in the plan notes)` : "none (the newest homework has answers)"}`,
  ];
  if (r.otherUnansweredHomework.length > 0)
    lines.push(
      `Older homework without an answers file (not imported; see the open threads): ${r.otherUnansweredHomework.join(", ")}`,
    );
  lines.push(
    `Model          ${String(r.attempts)} call${r.attempts === 1 ? "" : "s"} (edits accepted on attempt ${String(r.attempts)})`,
  );
  lines.push(
    "",
    "Couldn't place:",
    ...(r.unplaced.length ? r.unplaced.map((u) => `  - ${u}`) : ["  (nothing)"]),
  );
  if (r.missing.length > 0) lines.push("", "Not found:", ...r.missing.map((m) => `  - ${m}`));
  lines.push(
    "",
    "Open threads (copied into the plan notes):",
    r.openThreads ? indent(r.openThreads) : "  (none found)",
  );
  return lines.join("\n");
}

const indent = (text: string) =>
  text
    .split("\n")
    .map((line) => (line ? `  ${line}` : line))
    .join("\n");
