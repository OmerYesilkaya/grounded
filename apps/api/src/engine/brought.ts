import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { Phase } from "@grounded/core";
import { and, eq, learningSessions, sql, tracks, type Db } from "@grounded/db";
import { generateText, type FilePart, type TextPart } from "ai";
import type { FileStore } from "../files/store.js";
import { trackFileRows } from "../files/track-files.js";
import type { ModelAccess } from "./model-call.js";

/*
 * "What you brought" (design §4.5): the files a learner attached to a track. The first session's
 * probe and plan read them as they are, in the opening turn; a summary written once (tracks.brief)
 * stands in for them everywhere else, so later calls stay small.
 */

export interface BroughtFiles {
  names: string[];
  /** The files as the model reads them: images and PDFs as they are, the others as their text. */
  parts: (TextPart | FilePart)[];
}

/** The track's files for a model call; null when it has none. */
export async function broughtFiles(
  db: Db,
  store: FileStore,
  trackId: string,
): Promise<BroughtFiles | null> {
  const rows = await trackFileRows(db, trackId);
  if (rows.length === 0) return null;
  const parts = await Promise.all(
    rows.map(async (row): Promise<TextPart | FilePart> => {
      if (row.text !== null) return { type: "text", text: `${row.name}:\n\n${row.text}` };
      return {
        type: "file",
        data: await store.get(row.storageKey),
        mediaType: row.mediaType,
        filename: row.name,
      };
    }),
  );
  return { names: rows.map((r) => r.name), parts };
}

/** The line that introduces the files where they follow. */
export const filesLine = (names: readonly string[]) =>
  `They attached ${names.length === 1 ? "this file" : `these ${String(names.length)} files`}, which follow: ${names.join(", ")}.`;

const BRIEF_SYSTEM =
  "You read the files a learner attached when they started a track in a tutoring app, for the tutor's own later calls: those calls see your summary in place of the files. The tutor teaches from first principles, starting from what the learner already holds, and uses the learner's own world in examples.";

const BRIEF_PROMPT = `Summarize these files for the tutor, in at most about 300 words of plain lines. For each file: what it is, in a few words. Then what they show about the learner: what they already know or have done (name the specific tools, projects, courses, dates and levels), and what they want to reach. Keep the specifics the tutor can build on or use in examples; leave out contact details and anything else personal the teaching doesn't need. Say only what the files show; don't judge the learner. Reply with the summary only.`;

/** Writes the track's "what you brought" from its files and stores it. */
export async function writeBrief(options: {
  db: Db;
  trackId: string;
  goal: string;
  files: BroughtFiles;
  model: LanguageModelV4;
}): Promise<string | null> {
  const { db, trackId, files } = options;
  const { text } = await generateText({
    model: options.model,
    system: BRIEF_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `What the learner wrote they want to learn:\n\n${options.goal}\n\n${filesLine(files.names)}`,
          },
          ...files.parts,
          { type: "text", text: BRIEF_PROMPT },
        ],
      },
    ],
  });
  const brief = text.trim() || null;
  await db.update(tracks).set({ brief }).where(eq(tracks.id, trackId));
  return brief;
}

/** The phases whose calls read the files themselves in the track's first session: probe and plan. */
export const ORIGINALS_PHASES: readonly Phase[] = ["probe", "plan"];

/** Whether the session is the track's first: no session of the track began before it. */
export async function isFirstSession(db: Db, sessionId: string, trackId: string): Promise<boolean> {
  const [earlier] = await db
    .select({ id: learningSessions.id })
    .from(learningSessions)
    .where(
      and(
        eq(learningSessions.trackId, trackId),
        sql`${learningSessions.createdAt} < (select ${learningSessions.createdAt} from ${learningSessions} where ${learningSessions.id} = ${sessionId})`,
      ),
    )
    .limit(1);
  return !earlier;
}

/**
 * Writes "what you brought" for a track with files and none yet; returns it, or null when there is
 * nothing to write. A failed call throws.
 */
export async function briefTrack(options: {
  db: Db;
  store: FileStore;
  models: ModelAccess;
  trackId: string;
}): Promise<string | null> {
  const { db, trackId } = options;
  const [track] = await db.select().from(tracks).where(eq(tracks.id, trackId));
  if (!track) throw new Error(`no track ${trackId}`);
  if (track.brief !== null) return track.brief;
  const files = await broughtFiles(db, options.store, trackId);
  if (!files) return null;
  const model = await options.models.model({
    userId: track.userId,
    trackId,
    purpose: "track-brief",
    role: "strong",
  });
  return writeBrief({ db, trackId, goal: track.goal, files, model });
}
