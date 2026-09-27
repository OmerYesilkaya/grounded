import type { LearningTrack } from "./learning-folder.js";
import type { LedgerTerm } from "./ledger.js";
import { stateSection } from "./notes.js";

/**
 * The import's one model call. The terms and their statuses were already read from the ledger; the
 * model reads only what needs reading and answers with the terms' numbers.
 */
export const IMPORT_SYSTEM = `You are moving a learner's track from their earlier tutoring setup into a new app, so the tutor continues exactly where it left off. The earlier setup kept its state as markdown a tutor wrote for itself. Its term list has already been read, with each term's status: you get it numbered. Read the rest and answer with the terms' numbers only; never rename, merge or add a term.

- dependencies: what rests on what. The map is a diagram in a code fence: "A ──► B" means B rests on A; lines under a session heading build on its roots and on earlier sessions. Find the numbered terms each map line is about and record, for each term, the terms it rests on. The plan counts too where it says one thing needs another. Record only real dependencies; leave a term out when nothing it rests on is in the list.
- arcs: the plan's arcs in teaching order, closed ones included (say "closed" in the title), each with the numbered terms it teaches, in order.
- fixItems: misconceptions still open, to re-test: the plan's probe leaks and the open threads' leaks, relapses and gaps not yet repaired. Each one short and phrased as the belief to dislodge ("Postgres makes a plain read wait for a row being updated."), listed once even if several places mention it. Closed ones are left out.
- planNotes: a few plain lines the tutor reads first: where the track stands, what comes next, reorders and detours. The app appends the state's plan, open threads, session log and handoff notes verbatim; don't repeat them.
- unplaced: anything in the map or the plan you couldn't express with the numbered terms, one short line each.`;

export function importPrompt(track: LearningTrack, terms: readonly LedgerTerm[]): string {
  const numbered = terms.map((t, i) => `${String(i + 1)}. ${t.term} [${t.status}]`).join("\n");
  return [
    `# Track: ${track.title}`,
    track.readmeRow ? `## Its row in the tracks README\n\n${track.readmeRow}` : null,
    `## The terms, numbered, with their status\n\n${numbered}`,
    section(track, "map", "Map"),
    section(track, "plan", "Plan"),
    section(track, "open threads", "Open threads carried forward"),
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
}

function section(track: LearningTrack, prefix: string, heading: string): string | null {
  const body = stateSection(track, prefix);
  return body === null ? null : `## ${heading}\n\n${body}`;
}
