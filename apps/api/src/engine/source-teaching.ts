import type { CitedSource } from "@grounded/content";
import {
  chapterList,
  planActionsSchema,
  probeDecisionSchema,
  type SourceContext,
  type SourceReading,
} from "@grounded/core";
import {
  and,
  asc,
  eq,
  inArray,
  learningSessions,
  sourceChapters,
  sourcePassages,
  sql,
  trackFiles,
  tracks,
  type Db,
} from "@grounded/db";
import { z } from "zod";

/*
 * Teaching a track from its source, a chapter at a time (design §4.6). Every call carries the
 * source's map (its chapters with what each teaches and assumes) and how far the learner has read;
 * a session is about the chapter they were asked to read (and any they read beyond it): the probe
 * asks about it with its text in the prompt, the lesson teaches only its gaps from its passages
 * and cites them, and the close assigns the next chapter.
 */

/** Chapters whose summaries every call carries; beyond it, only those near at hand (titles stay). */
export const SOURCE_SUMMARIES_LIMIT = 40;
/** Around the chapters at hand, how many either side keep their summaries on a long source. */
const NEARBY = 3;
/** The most source text a probe or a lesson carries: about 15,000 tokens. */
export const SESSION_SOURCE_CHARACTERS = 60_000;

/**
 * The source as a call sees it, for a track with a source read; undefined for any other. With
 * many chapters, only those near the ones at hand keep their summaries.
 */
export async function loadSourceContext(
  db: Db,
  track: { id: string; source: SourceReading | null },
  session: { sourceChapters: number[] } | null,
): Promise<SourceContext | undefined> {
  if (!track.source) return undefined;
  const rows = await db
    .select({
      n: sourceChapters.n,
      title: sourceChapters.title,
      part: sourceChapters.part,
      pages: sourceChapters.pages,
      summary: sourceChapters.summary,
      assumes: sourceChapters.assumes,
      file: trackFiles.name,
    })
    .from(sourceChapters)
    .innerJoin(trackFiles, eq(trackFiles.id, sourceChapters.fileId))
    .where(eq(sourceChapters.trackId, track.id))
    .orderBy(asc(sourceChapters.n));
  if (rows.length === 0) return undefined;
  const assigned = track.source.assigned ?? null;
  const readThrough = track.source.readThrough ?? 0;
  const at = [...(session?.sourceChapters ?? []), ...(assigned === null ? [] : [assigned])];
  const all = rows.length <= SOURCE_SUMMARIES_LIMIT;
  const near = (n: number) => at.some((c) => Math.abs(c - n) <= NEARBY);
  return {
    files: [...new Set(rows.map((r) => r.file))],
    chapters: rows.map((r) => ({
      ...r,
      summary: (all || near(r.n)) && r.summary ? r.summary : null,
      assumes: (all || near(r.n)) && r.assumes ? r.assumes : null,
    })),
    readThrough,
    assigned,
    session: session?.sourceChapters ?? [],
  };
}

/** A chapter as the opening turn and the assignment name it. */
export interface ChapterNamed {
  n: number;
  title: string;
  pages: string | null;
  file: string;
}

export const chapterLabel = (c: ChapterNamed, files: number) =>
  [`Chapter ${String(c.n)}`, c.title, c.pages, files > 1 ? `in ${c.file}` : null]
    .filter(Boolean)
    .join(", ");

/** Chapters of the track by number, with their file. */
export async function chaptersNamed(
  db: Db,
  trackId: string,
  ns: readonly number[],
): Promise<ChapterNamed[]> {
  if (ns.length === 0) return [];
  return db
    .select({
      n: sourceChapters.n,
      title: sourceChapters.title,
      pages: sourceChapters.pages,
      file: trackFiles.name,
    })
    .from(sourceChapters)
    .innerJoin(trackFiles, eq(trackFiles.id, sourceChapters.fileId))
    .where(and(eq(sourceChapters.trackId, trackId), inArray(sourceChapters.n, [...ns])))
    .orderBy(asc(sourceChapters.n));
}

/**
 * The opening turn of a source track's session: the source, the chapter the learner was asked to
 * read before it, and why they are reading the source.
 */
export function sourceOpening(
  files: readonly string[],
  goal: string,
  assigned: ChapterNamed | null,
): string {
  const notes = goal.trim()
    ? `Why they are reading it, in their words: ${goal.trim()}`
    : "They left no notes on why they are reading it.";
  const reading = assigned
    ? `Before this session they were asked to read ${chapterLabel(assigned, files.length)}; open by asking how far they got.`
    : "Every chapter has been read.";
  return `(The learner started a session on the source they brought: ${files.join(", ")}. ${reading} ${notes})`;
}

/** The heading the probe's calls carry the chapter's text under. */
export const CHAPTER_TEXT = "The chapter the learner was asked to read";

/** What a probe or a lesson carries from the source: the chapters' text, and what a lesson may cite. */
export interface SessionPassages {
  /** The chapters' text, each passage headed; "" when the session is about no chapter. */
  text: string;
  /** For the lesson's request: the text, introduced; "" when there is none. */
  notes: string;
  /** The passages, numbered first among the sources the lesson's writer may cite. */
  cited: CitedSource[];
}

/**
 * The text of the chapters a session is about (design §4.6), for the probe's questions and the
 * lesson's writing, within the session's share; a passage past it is cut, and says so.
 */
export async function sessionPassages(
  db: Db,
  session: { trackId: string; sourceChapters: number[] },
): Promise<SessionPassages> {
  if (session.sourceChapters.length === 0) return { text: "", notes: "", cited: [] };
  const rows = await db
    .select({
      n: sourcePassages.n,
      pages: sourcePassages.pages,
      pageStart: sourcePassages.pageStart,
      text: sourcePassages.text,
      chapter: sourceChapters.n,
      title: sourceChapters.title,
      chapterPages: sourceChapters.pages,
      fileId: sourceChapters.fileId,
      file: trackFiles.name,
    })
    .from(sourcePassages)
    .innerJoin(sourceChapters, eq(sourceChapters.id, sourcePassages.chapterId))
    .innerJoin(trackFiles, eq(trackFiles.id, sourceChapters.fileId))
    .where(
      and(
        eq(sourcePassages.trackId, session.trackId),
        inArray(sourceChapters.n, session.sourceChapters),
      ),
    )
    .orderBy(asc(sourcePassages.n));
  let room = SESSION_SOURCE_CHARACTERS;
  const passages = rows.map((row, i) => {
    const text =
      row.text.length <= room
        ? row.text
        : `${row.text.slice(0, Math.max(0, room))}\n\n[The chapter goes on; the rest is left out here.]`;
    room = Math.max(0, room - row.text.length);
    const pages = row.pages ? `, ${row.pages}` : "";
    return `### [${String(i + 1)}] Chapter ${String(row.chapter)} ${row.title}${pages} (${row.file})\n\n${text}`;
  });
  const text = passages.join("\n\n");
  return {
    text,
    notes: text
      ? `\n\nThe text of ${chapterList(session.sourceChapters)}, which the learner was asked to read (they have it in their own copy). Teach only what they missed, as what the source says; a "[p. …]" line marks where a page starts, for citing the page. Each passage is source [n] for citing.\n\n${text}`
      : "",
    cited: rows.map((row) => ({
      url: `/api/tracks/${session.trackId}/files/${row.fileId}#${row.pageStart ? `page=${String(row.pageStart)}` : `chapter=${String(row.chapter)}`}`,
      title: [
        row.file,
        `Chapter ${String(row.chapter)} ${row.title}`,
        row.pages ?? row.chapterPages,
      ]
        .filter(Boolean)
        .join(", "),
    })),
  };
}

/**
 * The probe's decision on a source track (design §4.6): what the answers showed, whether probing
 * is finished, and how far the learner said they had read.
 */
export const sourceProbeDecisionSchema = probeDecisionSchema.extend({
  readThrough: z
    .number()
    .int()
    .nullable()
    .describe(
      "The last chapter the learner said they had finished reading, by its number as the source lists it; null if they said nothing new about how far they read. A chapter they started but didn't finish isn't finished.",
    ),
});

/**
 * Records how far the learner has read: the track's reading moves on, and the session takes in
 * the chapters they read beyond the one assigned, so the probe asks about those too. Reading less
 * than the assigned chapter changes nothing: it stays assigned.
 */
export async function recordReading(
  db: Db,
  track: { id: string; source: SourceReading | null },
  session: { id: string; sourceChapters: number[] },
  readThrough: number | null,
): Promise<number[]> {
  const reading = track.source;
  if (!reading || readThrough === null) return session.sourceChapters;
  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(sourceChapters)
    .where(eq(sourceChapters.trackId, track.id));
  const through = Math.min(Math.max(readThrough, reading.readThrough ?? 0), total);
  if (through === (reading.readThrough ?? 0)) return session.sourceChapters;
  await db
    .update(tracks)
    .set({ source: { ...reading, readThrough: through } })
    .where(eq(tracks.id, track.id));
  const first = session.sourceChapters[0] ?? reading.assigned;
  if (first === null || first === undefined || through < first) return session.sourceChapters;
  const chapters = Array.from({ length: through - first + 1 }, (_, i) => first + i);
  await db
    .update(learningSessions)
    .set({ sourceChapters: chapters })
    .where(eq(learningSessions.id, session.id));
  return chapters;
}

/** The plan's record on a source track: its actions, and whether this session teaches a lesson. */
export const sourcePlanActionsSchema = planActionsSchema.extend({
  lessonNeeded: z
    .boolean()
    .describe(
      "False when the probe found the learner holds what the chapter teaches and what it assumes, so this session teaches nothing and its homework follows the plan; true when a lesson teaches what they missed.",
    ),
});

/** The probe's summary on a source track: what the chapter's ideas showed, and what lies below. */
export const SOURCE_PROBE_SUMMARY_PROMPT =
  "(For the app; the learner doesn't see this.) The probe is finished. Write what it found, for the plan: how far the learner has read; then, for each idea the chapter they read teaches, whether they hold it, in their own words where you can, and where it stops; then what the chapter assumed from outside the source that they lack, if anything, and what the next chapter assumes that they lack. Where the probe found where an idea stops but not what they hold below it, say so; that is not the same as holding nothing. If everything held, say so plainly: the plan then teaches nothing this session. Plain prose, no preamble.";

/** What the close is told about the reading it assigns. */
export const NEXT_READING = "The next reading";

/**
 * At the close, the next chapter to read (design §4.6): the one after the last the learner
 * finished, or the session's own chapter again when they didn't finish it. Null once every chapter
 * is read. Recorded on the track, and said for the recap to name. Worked out from the session's
 * chapters, not the track's assignment, so a close run again lands on the same chapter.
 */
export async function assignNextReading(
  db: Db,
  trackId: string,
  sessionChapters: readonly number[],
): Promise<{ chapter: ChapterNamed; again: boolean; assumes: string; files: number } | null> {
  const [track] = await db
    .select({ source: tracks.source })
    .from(tracks)
    .where(eq(tracks.id, trackId));
  const reading = track?.source;
  const first = sessionChapters[0];
  if (!reading || first === undefined) return null;
  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(sourceChapters)
    .where(eq(sourceChapters.trackId, trackId));
  const readThrough = reading.readThrough ?? 0;
  const again = readThrough < first;
  const next = again ? first : readThrough + 1;
  const assigned = next <= total ? next : null;
  await db
    .update(tracks)
    .set({ source: { ...reading, assigned } })
    .where(eq(tracks.id, trackId));
  if (assigned === null) return null;
  const [chapter] = await chaptersNamed(db, trackId, [assigned]);
  if (!chapter) return null;
  const [row] = await db
    .select({ assumes: sourceChapters.assumes })
    .from(sourceChapters)
    .where(and(eq(sourceChapters.trackId, trackId), eq(sourceChapters.n, assigned)));
  const [{ files } = { files: 1 }] = await db
    .select({ files: sql<number>`count(*)::int` })
    .from(trackFiles)
    .where(and(eq(trackFiles.trackId, trackId), eq(trackFiles.role, "source")));
  return { chapter, again, assumes: row?.assumes ?? "", files };
}

/** The reading assignment, for the close's calls: the recap names it. */
export function nextReadingRecord(next: Awaited<ReturnType<typeof assignNextReading>>): {
  heading: string;
  body: string;
} {
  if (!next)
    return {
      heading: NEXT_READING,
      body: "Every chapter of the source has been read. There is no reading to assign; say so in the recap, and what the track can do next (the final, once the arcs are taught through).",
    };
  const label = chapterLabel(next.chapter, next.files);
  const assumes = next.assumes
    ? ` It expects the reader to know: ${next.assumes} Say so in a sentence where the learner may lack it.`
    : "";
  return {
    heading: NEXT_READING,
    body: next.again
      ? `The learner hasn't finished ${label}, so it stays assigned: the recap asks them to finish it before the next session.${assumes}`
      : `The app has assigned ${label} to read before the next session. Name it in the recap, as the next reading.${assumes}`,
  };
}
