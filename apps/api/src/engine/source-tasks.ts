import { cleanTitle, SOURCE_LIMITS, type SourceFailure, type SourceReading } from "@grounded/core";
import {
  and,
  asc,
  credentials,
  eq,
  isNull,
  sourceChapters,
  sourcePassages,
  sql,
  trackFiles,
  tracks,
  type Db,
} from "@grounded/db";
import { cheapModelFor, findModel, modelReads } from "@grounded/providers";
import type { Task, TaskList } from "graphile-worker";
import { v7 as uuidv7 } from "uuid";
import type { FileStore } from "../files/store.js";
import { addLogContext, log } from "../log.js";
import {
  DIVIDE_WINDOW_CHARACTERS,
  toChapters,
  type Divider,
  type DraftChapter,
} from "../sources/chapters.js";
import { divideChapter } from "../sources/divide.js";
import { readingEstimate, TRANSCRIBED_PAGE_CHARACTERS } from "../sources/estimate.js";
import { extractSource, UnreadableSource, type Extracted } from "../sources/extract.js";
import { pacedModel } from "../sources/paced.js";
import {
  summarizeChapters,
  summaryBatches,
  SUMMARY_BATCH_CHARACTERS,
} from "../sources/summarize.js";
import { TRANSCRIBE_BATCH, transcribePages } from "../sources/transcribe.js";
import { causeOf, type ModelAccess } from "./model-call.js";

/*
 * Reading a track's sources (design §4.6), in two jobs. The survey takes the text out with no
 * model, counts the pages the model has to read and estimates the cost; the learner sees it and
 * says to read. The reading transcribes those pages, divides the sources into chapters (the units
 * the learner reads) and their passages, summarizes each chapter, and assigns the first to read,
 * keeping what it has done as it goes, so reading that stops starts again where it stopped. A
 * reading makes many calls back to back, so a provider limiting requests is waited out (paced.ts)
 * rather than stopping it.
 */

export interface SourceTaskDependencies {
  db: Db;
  models: ModelAccess;
  files: FileStore;
}

interface TrackJob {
  trackId: string;
}

/** A track's reading before the survey has counted anything. */
export const SURVEYING: SourceReading = {
  status: "surveying",
  pages: 0,
  transcribe: 0,
  transcribed: 0,
  chapters: 0,
  summarized: 0,
  estimate: null,
  failure: null,
  assigned: null,
  readThrough: 0,
};

/** Merges a change into a track's reading. */
export async function updateReading(
  db: Db,
  trackId: string,
  change: Partial<SourceReading>,
): Promise<void> {
  await db
    .update(tracks)
    .set({
      source: sql`coalesce(${tracks.source}, '{}'::jsonb) || ${JSON.stringify(change)}::jsonb`,
    })
    .where(eq(tracks.id, trackId));
}

/** The model that reads a learner's sources: their provider's cheap one. */
async function readerOf(db: Db, userId: string) {
  const [credential] = await db
    .select({ provider: credentials.provider, model: credentials.model })
    .from(credentials)
    .where(eq(credentials.userId, userId));
  if (!credential) return null;
  const id = cheapModelFor(credential.provider)?.id ?? credential.model;
  return { id, label: findModel(id)?.label ?? id };
}

/** A source file opened, with its text taken out and its PDF pages the model has read applied. */
interface OpenedSource {
  file: typeof trackFiles.$inferSelect;
  bytes: Uint8Array;
  extracted: Extracted;
}

export function createSourceTasks(deps: SourceTaskDependencies): TaskList {
  const { db, models, files } = deps;

  const loadTrack = async (trackId: string) => {
    const [track] = await db.select().from(tracks).where(eq(tracks.id, trackId));
    if (!track) throw new Error(`no track ${trackId}`);
    addLogContext({ userId: track.userId, trackId });
    return track;
  };

  const sourceFiles = (trackId: string) =>
    db
      .select()
      .from(trackFiles)
      .where(and(eq(trackFiles.trackId, trackId), eq(trackFiles.role, "source")))
      .orderBy(asc(trackFiles.createdAt), asc(trackFiles.id));

  /** Opens every source; a file that can't be read ends the reading with its name. */
  const openSources = async (trackId: string): Promise<OpenedSource[] | SourceFailure> => {
    const opened: OpenedSource[] = [];
    for (const file of await sourceFiles(trackId)) {
      const bytes = await files.get(file.storageKey);
      try {
        const kind = file.kind === "image" ? null : file.kind;
        if (!kind) return { code: "source-unreadable", name: file.name };
        opened.push({ file, bytes, extracted: await extractSource(kind, bytes) });
      } catch (error) {
        if (!(error instanceof UnreadableSource)) throw error;
        log.info({ err: error }, "a source could not be read");
        return { code: "source-unreadable", name: file.name };
      }
    }
    return opened;
  };

  /** The PDF pages still to be read by the model: those it needs and hasn't read yet. */
  const unread = (source: OpenedSource) =>
    source.extracted.form === "paged"
      ? source.extracted.pages
          .filter((p) => p.needsModel && !(String(p.page) in source.file.transcripts))
          .map((p) => p.page)
      : [];

  /** A source's text with the pages the model has read in place of their empty text layers. */
  const withTranscripts = (source: OpenedSource): Extracted => {
    const { extracted } = source;
    return extracted.form === "paged"
      ? {
          ...extracted,
          pages: extracted.pages.map((p) => ({
            ...p,
            text: source.file.transcripts[String(p.page)] ?? p.text,
          })),
        }
      : extracted;
  };

  const fail = (trackId: string, failure: SourceFailure) =>
    updateReading(db, trackId, { status: "failed", failure });

  /** A job's failure: a model call's is the learner's to retry; anything else is ours. */
  const guarded =
    (run: (job: TrackJob) => Promise<void>): Task =>
    async (payload) => {
      const job = payload as TrackJob;
      try {
        await run(job);
      } catch (error) {
        const cause = causeOf(error);
        await fail(job.trackId, {
          code: "source-reading-stopped",
          cause: cause ?? { code: "our-side" },
        });
        if (!cause) {
          log.error({ err: error }, "reading a source failed on our side");
          throw error;
        }
        log.warn({ err: error }, "reading a source stopped at a model call");
      }
    };

  return {
    "survey-source": guarded(async ({ trackId }) => {
      const track = await loadTrack(trackId);
      if (track.source?.status !== "surveying") return;
      const opened = await openSources(trackId);
      if (!Array.isArray(opened)) return fail(trackId, opened);
      let pages = 0;
      let transcribe = 0;
      let characters = 0;
      let chapters = 0;
      let divide = 0;
      for (const source of opened) {
        const { extracted } = source;
        if (extracted.form === "paged") {
          pages += extracted.pages.length;
          const toRead = new Set(unread(source));
          transcribe += toRead.size;
          for (const page of extracted.pages)
            characters += toRead.has(page.page)
              ? TRANSCRIBED_PAGE_CHARACTERS
              : (source.file.transcripts[String(page.page)] ?? page.text).length;
        } else characters += extracted.chapters.reduce((sum, c) => sum + c.text.length, 0);
        // The chapters as the structure gives them; a long one with no headings is divided by the
        // model once the pages are read, so it counts as one here and its division is paid for.
        const counted = await toChapters(withTranscripts(source), null);
        chapters += counted.chapters.length;
        divide += counted.undivided;
      }
      if (characters > SOURCE_LIMITS.characters)
        return fail(trackId, {
          code: "source-too-long",
          characters,
          max: SOURCE_LIMITS.characters,
        });
      const reader = await readerOf(db, track.userId);
      if (transcribe > 0 && reader && !modelReads(reader.id, "application/pdf"))
        return fail(trackId, {
          code: "source-needs-vision",
          pages: transcribe,
          model: reader.label,
        });
      // The book's own title names the track, where the file says it.
      const title = opened.find((o) => o.extracted.title)?.extracted.title;
      if (title && opened.length === 1)
        await db
          .update(tracks)
          .set({ title: cleanTitle(title) ?? undefined })
          .where(eq(tracks.id, trackId));
      await updateReading(db, trackId, {
        status: "awaiting",
        pages,
        transcribe,
        transcribed: 0,
        chapters,
        estimate: reader
          ? readingEstimate({
              modelId: reader.id,
              transcribe,
              batch: TRANSCRIBE_BATCH,
              characters,
              chapters,
              divide,
              divideWindowCharacters: DIVIDE_WINDOW_CHARACTERS,
              summaryBatchCharacters: SUMMARY_BATCH_CHARACTERS,
            })
          : null,
      });
    }),

    "read-source": guarded(async ({ trackId }) => {
      const track = await loadTrack(trackId);
      if (track.source?.status !== "reading") return;
      const model = async (purpose: "source-transcribe" | "source-divide" | "source-summary") =>
        pacedModel(await models.model({ userId: track.userId, trackId, purpose, role: "cheap" }));

      // Chapters are made once, after every page is read; reading that starts again after them
      // only summarizes what is left.
      const [made] = await db
        .select({ n: sourceChapters.n })
        .from(sourceChapters)
        .where(eq(sourceChapters.trackId, trackId))
        .limit(1);
      if (!made) {
        const opened = await openSources(trackId);
        if (!Array.isArray(opened)) return fail(trackId, opened);
        let transcribed = 0;
        for (const source of opened) {
          const pages = unread(source);
          if (pages.length === 0) continue;
          await transcribePages({
            pdf: source.bytes,
            pages,
            model: () => model("source-transcribe"),
            onBatch: async (read) => {
              const added = Object.fromEntries([...read].map(([p, text]) => [String(p), text]));
              source.file.transcripts = { ...source.file.transcripts, ...added };
              await db
                .update(trackFiles)
                .set({
                  transcripts: sql`${trackFiles.transcripts} || ${JSON.stringify(added)}::jsonb`,
                })
                .where(eq(trackFiles.id, source.file.id));
              transcribed += read.size;
              await updateReading(db, trackId, { transcribed });
            },
          });
        }
        // Each file's chapters, numbered across the track in the order the files came; a long
        // chapter with no headings is divided by the model.
        const divider: Divider = async (chapter) =>
          divideChapter(await model("source-divide"), chapter);
        const drafts: (DraftChapter & { fileId: string })[] = [];
        for (const source of opened) {
          const { chapters } = await toChapters(withTranscripts(source), divider);
          drafts.push(...chapters.map((c) => ({ ...c, fileId: source.file.id })));
        }
        await db.transaction(async (tx) => {
          await tx.delete(sourceChapters).where(eq(sourceChapters.trackId, trackId));
          let passage = 0;
          for (const [i, draft] of drafts.entries()) {
            const id = uuidv7();
            await tx.insert(sourceChapters).values({
              id,
              trackId,
              fileId: draft.fileId,
              n: i + 1,
              title: draft.title,
              part: draft.part,
              pageStart: draft.pageStart,
              pages: draft.pages,
              characters: draft.characters,
            });
            await tx.insert(sourcePassages).values(
              draft.passages.map((p) => ({
                trackId,
                chapterId: id,
                n: ++passage,
                pageStart: p.pageStart,
                pages: p.pages,
                text: p.text,
              })),
            );
          }
        });
        await updateReading(db, trackId, { chapters: drafts.length, summarized: 0 });
      }

      const left = await db
        .select({ id: sourceChapters.id, n: sourceChapters.n, title: sourceChapters.title })
        .from(sourceChapters)
        .where(and(eq(sourceChapters.trackId, trackId), isNull(sourceChapters.summary)))
        .orderBy(asc(sourceChapters.n));
      const passages = await db
        .select({ chapterId: sourcePassages.chapterId, text: sourcePassages.text })
        .from(sourcePassages)
        .where(eq(sourcePassages.trackId, trackId))
        .orderBy(asc(sourcePassages.n));
      const unsummarized = left.map((chapter) => ({
        ...chapter,
        text: passages
          .filter((p) => p.chapterId === chapter.id)
          .map((p) => p.text)
          .join("\n\n"),
      }));
      const [{ total } = { total: 0 }] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(sourceChapters)
        .where(eq(sourceChapters.trackId, trackId));
      let summarized = total - unsummarized.length;
      for (const batch of summaryBatches(unsummarized)) {
        const found = await summarizeChapters(await model("source-summary"), batch);
        for (const chapter of batch) {
          // A chapter the reply left out keeps its title alone; the map still lists it.
          const written = found.get(chapter.n) ?? { summary: "", assumes: "" };
          await db.update(sourceChapters).set(written).where(eq(sourceChapters.id, chapter.id));
        }
        summarized += batch.length;
        await updateReading(db, trackId, { summarized });
      }
      // Read: the first chapter is the one to read first (design §4.6).
      await updateReading(db, trackId, {
        status: "ready",
        chapters: total,
        failure: null,
        assigned: total > 0 ? 1 : null,
        readThrough: 0,
      });
    }),
  };
}
