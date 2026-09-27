import type { LearningTrack } from "./learning-folder.js";

/** state.md sections copied after the open threads, the owed homework and the last lesson. */
const LATER_SECTIONS = [
  { prefix: "plan", heading: "The plan as it was written" },
  { prefix: "borrowed", heading: "Borrowed" },
  { prefix: "session log", heading: "Session log" },
] as const;

export function stateSection(track: LearningTrack, prefix: string): string | null {
  for (const [heading, body] of track.sections)
    if (heading.toLowerCase().startsWith(prefix)) return body;
  return null;
}

/**
 * The plan's notes: the model's few lines, then the earlier setup's own words, verbatim. The notes sit
 * under the prompt's "## Plan" heading, so copied headings are pushed below level 3.
 */
export function composePlanNotes(modelNotes: string, track: LearningTrack): string {
  const parts: string[] = [];
  if (modelNotes.trim()) parts.push(modelNotes.trim());
  parts.push(
    `### From the earlier setup (imported, as of ${track.snapshotDate ?? "the last session"})\n\nCopied verbatim from the learner's earlier notes; the term list and arcs were built from them.`,
  );

  const threads = stateSection(track, "open threads");
  if (threads) parts.push(`### Open threads carried forward\n\n${demote(threads)}`);

  if (track.owedHomework) {
    parts.push(
      `### Owed homework: ${track.owedHomework.folder} (assigned, no answers yet)\n\nReview it at the next session's review once the learner has done it. Its full text:\n\n${demote(track.owedHomework.text.trim())}`,
    );
  }

  if (track.latestLesson) {
    const { folder, title } = track.latestLesson;
    const unlogged = !track.state.includes(folder)
      ? " It isn't in the session log below: the state was last written before it, so whatever happened in its session wasn't recorded."
      : "";
    parts.push(
      `### The last lesson: ${folder}\n\n"${title}" is the last lesson the learner was given; they can reread it on the track page.${unlogged}`,
    );
  }

  for (const { prefix, heading } of LATER_SECTIONS) {
    const body = stateSection(track, prefix);
    if (body) parts.push(`### ${heading}\n\n${demote(body)}`);
  }
  if (track.handoff) parts.push(`### Handoff notes\n\n${demote(track.handoff.trim())}`);
  return parts.join("\n\n");
}

/** Pushes markdown headings (outside code fences) four levels down, so they nest under ours. */
export function demote(markdown: string): string {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) fenced = !fenced;
      const match = fenced ? null : /^(#{1,6}) (.*)$/.exec(line);
      if (!match?.[1]) return line;
      return `${"#".repeat(Math.min(6, match[1].length + 4))} ${match[2] ?? ""}`;
    })
    .join("\n");
}
