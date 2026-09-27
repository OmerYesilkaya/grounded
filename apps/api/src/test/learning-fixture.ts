import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImportReading } from "@grounded/core";

/*
 * A small synthetic track in the earlier setup's format (a "Learning" folder): the same sections,
 * tables and " · " lists as the real state.md, about a made-up subject.
 */

export const STATE = `# Learning state — track \`cooking-basics\`

Rewritten at the close of every session.

## Ledger

### Assumed (held before teaching, from probing)
knife · stove ·
boiling water (probe floor) · salt dissolves
· **P1 probe floors (2026-01-04):** a whisk mixes air in; oil floats on water

### Confirmed (used correctly in his own words or passed a check)
| Term | Evidence |
| --- | --- |
| heat moves from the hot pan into the food (conduction) | Session 1 check 2: "the pan warms the egg from below" |
| **a lid traps steam** | Session 1 check 3 |

| salt raises the boiling point only slightly | Session 2 homework |

### Taught (defined and motivated; not yet confirmed by his usage)
| Term | Where | Note |
| --- | --- | --- |
| Maillard reaction | Session 2 lesson | check leaked once |
| emulsion | Session 3 lesson | |

### Planned (in the arc, not yet taught)
roux ·
from S3: hollandaise · mayonnaise · Emulsion ·
(arc B remaining: beurre blanc, pan sauce) · bread
crust

## Map

\`\`\`
ROOTS he held before teaching
 └─ a stove makes a pan hot
## not a heading: inside the diagram
 conduction ──► Maillard reaction
\`\`\`

## Plan

Arcs: **A** heat (closed) → **B** sauces (started 2026-01-05).

## Borrowed

None.

## Session log

| Folder | Topic | Homework |
| --- | --- | --- |
| 2026-01-01-knife-skills | knives and heat | reviewed and closed |
| 2026-01-03-heat | browning | assigned |

## Open threads carried forward

- Re-probe the Maillard reaction cold (check leaked once).
- Believes salt makes water boil much faster.
`;

export const HANDOFF = `# Handoff

## Where things stand

Arc A closed; arc B started.
`;

export const README = `# Tracks

| Track | What it is | Where it stands |
| --- | --- | --- |
| \`cooking-basics\` | Cooking from first principles. | Arc B started. |
`;

export const OWED_HOMEWORK = `# Homework: browning

## Part A

Brown two onions, one covered and one not. **Predict** which browns first, then reconcile.
`;

export const LATEST_LESSON = `<!doctype html>
<html><head><title>Sauces &amp; emulsions — 2026-01-05</title>
<script>document.title = "ran";</script></head>
<body><h1>Sauces</h1><p>Oil and water.</p></body></html>`;

/** Writes the synthetic Learning folder; returns the track folder (the one holding state.md). */
export async function writeLearningFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "learning-"));
  const tracks = join(root, "tracks");
  const track = join(tracks, "cooking-basics");
  const file = async (path: string, text: string) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
  };
  await file(join(tracks, "README.md"), README);
  await file(join(track, "state.md"), STATE);
  await file(join(track, "handoff.md"), HANDOFF);
  await file(join(track, "2026-01-01-knife-skills", "lesson.html"), "<title>Knives</title>");
  await file(join(track, "2026-01-01-knife-skills", "homework.md"), "# Homework: knives\n");
  await file(join(track, "2026-01-01-knife-skills", "homework-answers.md"), "Answers.\n");
  await file(join(track, "2026-01-02-stocks", "homework.md"), "# Homework: stocks\n");
  await file(join(track, "2026-01-03-heat", "lesson.html"), "<title>Heat</title>");
  await file(join(track, "2026-01-03-heat", "homework.md"), OWED_HOMEWORK);
  await file(join(track, "2026-01-05-sauces", "lesson.html"), LATEST_LESSON);
  return track;
}

/**
 * The model's reading of the fixture, by term number. The terms as the ledger lists them, first
 * appearance first: 1 knife, 2 stove, 3 boiling water (probe floor), 4 salt dissolves, 5 a whisk mixes
 * air in, 6 oil floats on water, 7 heat moves… (conduction), 8 a lid traps steam, 9 salt raises the
 * boiling point only slightly, 10 Maillard reaction, 11 emulsion, 12 roux, 13 hollandaise,
 * 14 mayonnaise, 15 beurre blanc, 16 pan sauce, 17 bread crust.
 */
export function fixtureReading(): ImportReading {
  return {
    dependencies: [
      { term: 7, restsOn: [2] },
      { term: 10, restsOn: [7] },
      { term: 11, restsOn: [6, 5] },
      { term: 13, restsOn: [11] },
    ],
    arcs: [
      { title: "A — heat (closed)", terms: [7, 8, 9, 10] },
      { title: "B — sauces", terms: [11, 12, 13, 14, 15, 16] },
    ],
    fixItems: ["Salt makes water boil much faster."],
    planNotes: "Arc B has started: sauces next.",
    unplaced: ["The map's root 'a stove makes a pan hot' is a sentence, not a term."],
  };
}
