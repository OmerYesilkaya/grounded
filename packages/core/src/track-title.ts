/*
 * A track's short name (design §9.5). The learner writes what they want to learn, as much as they
 * like; the track list needs a few words. Words that already are a name are used as they are; for
 * anything longer the tutor names the track, and until it has, the first line stands in.
 */

/** The longest a track's name may be. */
export const TITLE_MAX = 60;

/** Whether the learner's words need a name from the tutor: more than one line, or too long. */
export function needsNaming(goal: string): boolean {
  const words = goal.trim();
  return words.includes("\n") || words.length > TITLE_MAX;
}

/** The learner's first line, cut at a word to fit: the name until the tutor's arrives, or if it fails. */
export function standInTitle(goal: string): string {
  const line = (goal.trim().split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
  return shorten(line);
}

/** The tutor's name for the track, cleaned; null when nothing usable is left. */
export function cleanTitle(name: string): string | null {
  const cleaned = name
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’«»]+|["'“”‘’«».]+$/g, "")
    .trim();
  return cleaned ? shorten(cleaned) : null;
}

function shorten(text: string): string {
  if (text.length <= TITLE_MAX) return text;
  const cut = text.slice(0, TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
