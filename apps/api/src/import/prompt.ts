import type { LearningTrack } from "./learning-folder.js";

/** How to turn the earlier setup's state into the app's track edits. */
export const IMPORT_SYSTEM = `You are moving a learner's track from their earlier tutoring setup into a new app, so the tutor continues exactly where it left off. The earlier setup kept its state as markdown written by a tutor for itself; the app keeps a term list, a map of what rests on what, a plan, and a fix-list, changed only through edits. Return the whole track as one batch of edits.

The state's ledger has four sections. Each row or " · "-separated item is one or more terms:
- **Assumed**: held before teaching. Record each with set-term-status "assumed"; the evidence is what the ledger says about it (a probe floor, "held before teaching").
- **Confirmed**: add it with add-planned-term (with what it rests on), then set-term-status "confirmed" with the row's evidence.
- **Taught**: the same, with "taught"; the evidence is the row's "where" and note.
- **Planned**: add-planned-term only. A parenthesised list of what an arc still has to teach is a list of planned terms.

Terms:
- A term is the name a tutor would use for the idea: "closure", "microtask queue", "write-ahead log (WAL)". Many rows describe an idea in a sentence; give such a row a short name. A row naming several distinct ideas becomes several terms, each with the row's evidence.
- Never lose information: when you shorten a row into a name, the evidence starts with the row's own words, then its evidence, verbatim ("one frame per call, functions born in the same call share it — homework A, two-counter checks").
- One term per name. If the same idea appears in two sections, keep the more advanced status (confirmed over taught over planned) and put both notes in the evidence.
- Early made-up labels that were replaced by real terms ("the pile" for the call stack) are not terms of their own; mention the label in the real term's evidence.

What rests on what comes from the map (a diagram in a code fence) and the ledger: "A ──► B" means B rests on A. Record only real dependencies, with restsOn naming terms exactly as you named them. Order the batch so every term exists before anything rests on it or changes its status: set-language first, then every assumed term, then add-planned-term for every other term in dependency order, then the taught and confirmed statuses. Assumed terms have no restsOn.

Misconceptions still open (a leak not yet repaired, a belief the plan says to dislodge, a relapse still being watched) become add-fix-item, phrased as the belief to dislodge. Closed ones are not added.

End with exactly one set-plan: the arcs in teaching order, closed ones included (say "closed" in the title), each with the terms it teaches, named exactly as in the term list. Its notes are a few plain lines: where the track stands, what comes next, and reorders or detours. The app appends the state's plan, open threads, session log, handoff notes and any owed homework to your notes verbatim; don't repeat them.

set-language: the language the lessons are written in.

Anything you cannot express as an edit goes in "unplaced", one short line each.`;

export function importPrompt(track: LearningTrack): string {
  return [
    `# Track: ${track.title}`,
    track.readmeRow ? `## Its row in the tracks README\n\n${track.readmeRow}` : null,
    `## state.md\n\n${track.state}`,
    track.handoff ? `## handoff.md\n\n${track.handoff}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
}
