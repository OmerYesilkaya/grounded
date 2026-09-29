import type { SessionItem, TrackItem, TrackSummary } from "./tracks";

/** Where an open session stands, when its lesson's terms can't say what it is about yet. */
const UNDER_WAY: Record<SessionItem["phase"], string> = {
  probe: "Finding where you start",
  plan: "Choosing what comes next",
  lesson: "The lesson is being written",
  homework: "Homework",
  close: "Wrapping up",
  closed: "Finished",
};

const PHASE: Record<SessionItem["phase"], string> = {
  probe: "getting started",
  plan: "planning",
  lesson: "lesson",
  homework: "homework",
  close: "wrapping up",
  closed: "done",
};

/**
 * What an item's row says (design §9.2): what it is about, over what it is. A session shows its
 * lesson's title (or, for a lesson outlined before titles, the terms it introduces) over its number
 * and phase; before there is a lesson, what is under way stands in. Homework shows its name over
 * "Homework · session 4" (and "· handed in", or "· folded into session 6"); an arc exam over
 * "Arc exam · session 4" (and "· handed in").
 */
export function describeItem(item: TrackItem): { title: string; meta: string } {
  if (item.kind === "exam")
    return {
      title: item.title,
      meta: `Arc exam · session ${String(item.session)}${item.done ? " · handed in" : ""}`,
    };
  if (item.kind === "homework")
    return {
      title: item.title,
      meta: `Homework · session ${String(item.session)}${
        item.foldedInto !== null
          ? ` · folded into session ${String(item.foldedInto)}`
          : item.done
            ? " · handed in"
            : ""
      }`,
    };
  const number = `Session ${String(item.number)}`;
  if (item.lessonTitle === null && item.terms.length === 0)
    return { title: UNDER_WAY[item.phase], meta: number };
  const terms = item.terms.join(", ");
  return {
    title: item.lessonTitle ?? terms.charAt(0).toLocaleUpperCase() + terms.slice(1),
    meta: item.done ? number : `${number} · ${PHASE[item.phase]}`,
  };
}

/** From this many tracks on, the list shows the most recently active few (design §9.2). */
export const MANY_TRACKS = 15;
export const SHOWN_OF_MANY = 6;

/**
 * The tracks to show without a search: all of them, or at scale the most recently active few (the
 * list comes ordered by activity) plus the page's track wherever it falls. `hidden` is what the rest
 * adds up to, for "N more tracks".
 */
export function shortList(
  tracks: readonly TrackSummary[],
  currentTrackId: string | undefined,
  showAll: boolean,
): { shown: TrackSummary[]; hidden: number } {
  if (showAll || tracks.length < MANY_TRACKS) return { shown: [...tracks], hidden: 0 };
  const shown = tracks.filter((t, i) => i < SHOWN_OF_MANY || t.id === currentTrackId);
  return { shown, hidden: tracks.length - shown.length };
}

/** Lower case without accents, so "misir" finds "Mısır" and "ecole" finds "École". */
function folded(text: string): string {
  return text
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replaceAll("ı", "i");
}

export interface Found {
  track: TrackSummary;
  /** The items that match; null when the track's name matches, so all of it is found. */
  items: TrackItem[] | null;
}

/**
 * The live search (design §9.2): every word of the query must appear, in any order. A track whose
 * name holds them all is found whole; otherwise it is found for the items that hold them (the
 * track's name counting towards each item, so "sql joins" finds the joins lesson of the SQL track).
 */
export function searchTracks(tracks: readonly TrackSummary[], query: string): Found[] {
  const words = folded(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return tracks.map((track) => ({ track, items: null }));
  const holdsAll = (text: string) => {
    const haystack = folded(text);
    return words.every((word) => haystack.includes(word));
  };
  return tracks.flatMap((track): Found[] => {
    if (holdsAll(track.title)) return [{ track, items: null }];
    const items = track.items.filter((item) => {
      const { title, meta } = describeItem(item);
      // A lesson is found by the terms it teaches too, which its title doesn't show; an exam by
      // the arcs it covers.
      const terms =
        item.kind === "session"
          ? item.terms.join(" ")
          : item.kind === "exam"
            ? item.arcs.join(" ")
            : "";
      return holdsAll(`${track.title} ${title} ${meta} ${terms}`);
    });
    return items.length ? [{ track, items }] : [];
  });
}
