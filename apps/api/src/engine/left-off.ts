import type { LanguageModelV4 } from "@ai-sdk/provider";
import { eq, tracks, type Db } from "@grounded/db";
import { generateText, type ModelMessage, type SystemModelMessage } from "ai";
import { withActivity } from "./events.js";

/*
 * "Where you left off" (design §4.4): a compact summary of the plan's notes and the last session,
 * written at each close. Every prompt but the close's carries it in place of the notes, which stay
 * in the database for the close to read and update.
 */

/**
 * Plan notes longer than this with no summary yet (an imported track, whose notes run to 34 KB) get
 * one before the session's first question. Shorter ones are carried as written until the first close.
 */
export const LEFT_OFF_CATCH_UP = 4000;

const WHAT_IT_HOLDS =
  "It is for your own later calls, which see it in place of the plan's notes; the notes stay in the app. Keep it compact, at most about 300 words of plain lines: the open threads (questions and tangents still open), owed work (homework or exams assigned and not yet reviewed, checks still owed), what to re-check (ideas still settling, leaks, misconceptions to re-test), where the lesson was pitched below the learner (what they already held, so the next plan starts above it), and where the next session picks up. Name terms exactly as the term list does. Leave out what is settled and what the term list, fix-list or arcs already say. Reply with the summary only.";

/** At the close, after the recap and the term sweep. */
export const LEFT_OFF_PROMPT = `(For the app; the learner doesn't see this.) The session is closed. Write where the learner left off on this track, from the plan's notes and this session. ${WHAT_IT_HOLDS}`;

/** For notes that have no summary yet, before a session opens. */
export const LEFT_OFF_CATCH_UP_PROMPT = `(For the app; the learner doesn't see this.) A session is about to open. Write where the learner left off on this track, from the plan's notes. ${WHAT_IT_HOLDS}`;

/** Writes "where you left off" for the track and stores it. */
export async function writeLeftOff(options: {
  db: Db;
  sessionId: string;
  trackId: string;
  model: LanguageModelV4;
  system: SystemModelMessage[];
  messages: ModelMessage[];
  label: string;
}): Promise<void> {
  const { db, sessionId, trackId } = options;
  const { text } = await withActivity(db, sessionId, options.label, () =>
    generateText({ model: options.model, system: options.system, messages: options.messages }),
  );
  await db
    .update(tracks)
    .set({ leftOff: text.trim() || null })
    .where(eq(tracks.id, trackId));
}
