import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { CitedSource } from "@grounded/content";
import type { SourceContext } from "@grounded/core";
import {
  and,
  asc,
  eq,
  inArray,
  learningSessions,
  sourceSections,
  trackFiles,
  tracks,
  type Db,
  type SourceMap,
  type TrackPlan,
} from "@grounded/db";
import { generateText, Output, type ModelMessage, type SystemModelMessage } from "ai";
import { z } from "zod";

/*
 * Teaching a track from its source (design §4.6). Every call carries the source's map (its
 * sections with what each covers); after each plan, a call records which sections each arc teaches
 * from, which the learner already holds, and which this session's lesson teaches from; the lesson
 * carries those sections' text in place of web research, and cites them.
 */

/** Sections whose summaries every call carries; beyond it, only the current arc's (titles stay). */
export const SOURCE_SUMMARIES_LIMIT = 40;
/** The most source text a lesson carries: about 15,000 tokens, two or three sections. */
export const LESSON_SOURCE_CHARACTERS = 60_000;
/** The most sections one session's lesson teaches from. */
export const SESSION_SECTIONS = 3;

/**
 * The source as a call sees it, for a track with a source read; undefined for any other. With
 * many sections, only those of the current arc keep their summaries.
 */
export async function loadSourceContext(
  db: Db,
  track: { id: string; source: unknown; sourceMap: SourceMap | null },
  currentArc: string | null,
): Promise<SourceContext | undefined> {
  if (!track.source) return undefined;
  const rows = await db
    .select({
      n: sourceSections.n,
      title: sourceSections.title,
      pages: sourceSections.pages,
      summary: sourceSections.summary,
      file: trackFiles.name,
    })
    .from(sourceSections)
    .innerJoin(trackFiles, eq(trackFiles.id, sourceSections.fileId))
    .where(eq(sourceSections.trackId, track.id))
    .orderBy(asc(sourceSections.n));
  if (rows.length === 0) return undefined;
  const map = track.sourceMap;
  const inArc = new Set(map?.arcs.find((a) => a.title === currentArc)?.sections ?? []);
  const all = rows.length <= SOURCE_SUMMARIES_LIMIT;
  return {
    files: [...new Set(rows.map((r) => r.file))],
    sections: rows.map((r) => ({
      ...r,
      summary: (all || inArc.has(r.n)) && r.summary ? r.summary : null,
    })),
    map,
  };
}

export const SOURCE_MAP_PROMPT = `(For the app; the learner doesn't see this.) Map the plan you just presented onto the source, by its sections' numbers. For each arc of the plan, in order and with its title exactly as recorded: the sections it teaches from, or none for an arc of groundwork from outside the source. Then the sections the probe showed the learner already holds, which the plan skips or only checks. Then the sections this session's lesson teaches from, in order: at most ${String(SESSION_SECTIONS)}, none if it teaches only groundwork.`;

const sourceMapSchema = z.object({
  arcs: z.array(z.object({ title: z.string(), sections: z.array(z.number().int()) })),
  known: z.array(z.number().int()),
  session: z.array(z.number().int()),
});

/**
 * Records, after a plan, what it teaches from where (design §4.6): the track's map, kept with its
 * plan's arcs (an arc the reply leaves out teaches from nothing yet), and the session's sections.
 */
export async function mapSource(options: {
  db: Db;
  model: LanguageModelV4;
  system: SystemModelMessage[];
  messages: ModelMessage[];
  trackId: string;
  sessionId: string;
}): Promise<SourceMap> {
  const { db, trackId } = options;
  const { output } = await generateText({
    model: options.model,
    system: options.system,
    output: Output.object({ schema: sourceMapSchema }),
    messages: [...options.messages, { role: "user", content: SOURCE_MAP_PROMPT }],
  });
  const [track] = await db.select({ plan: tracks.plan }).from(tracks).where(eq(tracks.id, trackId));
  const numbers = await db
    .select({ n: sourceSections.n })
    .from(sourceSections)
    .where(eq(sourceSections.trackId, trackId));
  const map = shapeSourceMap(
    output,
    track?.plan ?? { arcs: [], notes: "" },
    new Set(numbers.map((r) => r.n)),
  );
  await db.update(tracks).set({ sourceMap: map.track }).where(eq(tracks.id, trackId));
  await db
    .update(learningSessions)
    .set({ sourceSections: map.session.length ? map.session : null })
    .where(eq(learningSessions.id, options.sessionId));
  return map.track;
}

/**
 * The model's map held to what exists: the plan's arcs in the plan's order (matched by title, as
 * written or by case), section numbers the source has, each once; a session of a few sections.
 */
export function shapeSourceMap(
  output: z.infer<typeof sourceMapSchema>,
  plan: TrackPlan,
  numbers: ReadonlySet<number>,
): { track: SourceMap; session: number[] } {
  const valid = (ns: readonly number[]) => [...new Set(ns.filter((n) => numbers.has(n)))];
  const byTitle = new Map(output.arcs.map((a) => [a.title.trim().toLowerCase(), a.sections]));
  return {
    track: {
      arcs: plan.arcs.map((arc) => ({
        title: arc.title,
        sections: valid(byTitle.get(arc.title.trim().toLowerCase()) ?? []),
      })),
      known: valid(output.known),
    },
    session: valid(output.session).slice(0, SESSION_SECTIONS),
  };
}

/** What a lesson carries from the source: the sections' text for its prompt, and what it may cite. */
export interface LessonPassages {
  /** For the lesson's request; "" when it teaches from no section. */
  notes: string;
  /** The sections, numbered first among the sources the writer may cite. */
  cited: CitedSource[];
}

/**
 * The source's text a session's lesson teaches from (design §4.6): the sections its plan mapped,
 * or, where the plan's map wasn't recorded, the current arc's first ones. Within the lesson's
 * share; a section past it is cut, and says so.
 */
export async function lessonPassages(
  db: Db,
  session: { trackId: string; sourceSections: number[] | null },
  currentArc: string | null,
): Promise<LessonPassages> {
  const [track] = await db
    .select({ map: tracks.sourceMap })
    .from(tracks)
    .where(eq(tracks.id, session.trackId));
  const wanted =
    session.sourceSections ??
    (track?.map?.arcs.find((a) => a.title === currentArc)?.sections ?? []).slice(
      0,
      SESSION_SECTIONS,
    );
  if (wanted.length === 0) return { notes: "", cited: [] };
  const rows = await db
    .select({
      n: sourceSections.n,
      title: sourceSections.title,
      pages: sourceSections.pages,
      pageStart: sourceSections.pageStart,
      text: sourceSections.text,
      fileId: sourceSections.fileId,
      file: trackFiles.name,
    })
    .from(sourceSections)
    .innerJoin(trackFiles, eq(trackFiles.id, sourceSections.fileId))
    .where(and(eq(sourceSections.trackId, session.trackId), inArray(sourceSections.n, wanted)))
    .orderBy(asc(sourceSections.n));
  let room = LESSON_SOURCE_CHARACTERS;
  const passages = rows.map((row, i) => {
    const text =
      row.text.length <= room
        ? row.text
        : `${row.text.slice(0, Math.max(0, room))}\n\n[The section goes on; the rest is left out here.]`;
    room = Math.max(0, room - row.text.length);
    const pages = row.pages ? `, ${row.pages}` : "";
    return `### [${String(i + 1)}] §${String(row.n)} ${row.title}${pages} (${row.file})\n\n${text}`;
  });
  return {
    notes: `\n\nThe source's text this lesson teaches from (the learner hasn't seen it here). Teach what it says, as what the source says; a "[p. …]" line marks where a page starts, for citing the page. Each passage is source [n] for citing.\n\n${passages.join("\n\n")}`,
    cited: rows.map((row) => ({
      url: `/api/tracks/${session.trackId}/files/${row.fileId}#${row.pageStart ? `page=${String(row.pageStart)}` : `section=${String(row.n)}`}`,
      title: [row.file, `§${String(row.n)} ${row.title}`, row.pages].filter(Boolean).join(", "),
    })),
  };
}

/** The opening turn of a source track's session: the source, and why the learner reads it. */
export function sourceOpening(files: readonly string[], goal: string): string {
  const notes = goal.trim()
    ? `Why they are reading it, in their words: ${goal.trim()}`
    : "They left no notes on why they are reading it.";
  return `(The learner started a session to learn from the source they brought: ${files.join(", ")}. ${notes})`;
}
