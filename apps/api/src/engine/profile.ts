import {
  and,
  assignments,
  asc,
  desc,
  eq,
  gt,
  inArray,
  learnerProfileNotes,
  learningSessions,
  lte,
  profileRefreshes,
  reviews,
  sessionMessages,
  sql,
  tracks,
  type Db,
  type NoteEvidence,
} from "@grounded/db";
import {
  assembleSystemPrompt,
  teachingNotesSchema,
  type Method,
  type TeachingNotesRefresh,
} from "@grounded/core";
import { generateText, Output } from "ai";
import type { TaskList } from "graphile-worker";
import { addLogContext, log } from "../log.js";
import { ASKED_IN_THE_MARGIN, asidesRecord } from "./asides.js";
import { systemMessages } from "./call-options.js";
import { loadCheckRecord } from "./check-record.js";
import type { Tx } from "./events.js";
import { NoCredentialError, ProviderCallError, type ModelAccess } from "./model-call.js";
import { reportHandledFailure } from "./queue.js";
import { HOMEWORK_REVIEWED, sessionReviewRecord } from "./reviews.js";

/*
 * The learner's teaching notes (design §8): a few lines about how this person learns, in every
 * call's context. The profile job refreshes them at a session close, from the evidence of the
 * sessions since the last refresh, across all their tracks; the learner reads and edits them.
 */

/** The first refresh waits for this many closed sessions, across tracks: before, there is no pattern. */
export const FIRST_REFRESH_AFTER = 6;
/** Then one comes about every this many closed sessions. */
export const REFRESH_EVERY = 5;
/** About a dozen notes at most: they are in every call. */
export const TEACHING_NOTES_MAX = 12;

/** The learner's teaching notes, oldest first, as the prompt carries them. */
export async function loadTeachingNotes(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ text: learnerProfileNotes.text })
    .from(learnerProfileNotes)
    .where(eq(learnerProfileNotes.userId, userId))
    .orderBy(asc(learnerProfileNotes.createdAt), asc(learnerProfileNotes.id));
  return rows.map((r) => r.text);
}

/** The learner's latest refresh; null before the first. */
async function lastRefresh(db: Db | Tx, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: profileRefreshes.id })
    .from(profileRefreshes)
    .where(eq(profileRefreshes.userId, userId))
    .orderBy(desc(profileRefreshes.createdAt), desc(profileRefreshes.id))
    .limit(1);
  return row?.id ?? null;
}

/**
 * The learner's sessions closed since the last refresh (all of them before the first), in order.
 * Compared in the database, at its precision: a JavaScript Date keeps only milliseconds.
 */
export async function sessionsSinceRefresh(db: Db, userId: string) {
  const last = sql`coalesce((select max(${profileRefreshes.createdAt}) from ${profileRefreshes} where ${profileRefreshes.userId} = ${userId}), '-infinity'::timestamptz)`;
  return db
    .select()
    .from(learningSessions)
    .where(and(eq(learningSessions.userId, userId), gt(learningSessions.closedAt, last)))
    .orderBy(asc(learningSessions.closedAt), asc(learningSessions.id));
}

type ClosedSession = Awaited<ReturnType<typeof sessionsSinceRefresh>>[number];

/**
 * The learner's sessions closed before the last refresh whose homework (or exam) was reviewed since:
 * handed in after a "Later", its review is evidence the last refresh didn't have.
 */
export async function reviewedSinceRefresh(db: Db, userId: string) {
  const last = sql`coalesce((select max(${profileRefreshes.createdAt}) from ${profileRefreshes} where ${profileRefreshes.userId} = ${userId}), '-infinity'::timestamptz)`;
  return db
    .select()
    .from(learningSessions)
    .where(
      and(
        eq(learningSessions.userId, userId),
        lte(learningSessions.closedAt, last),
        sql`exists (select 1 from ${assignments} join ${reviews} on ${reviews.assignmentId} = ${assignments.id} where ${assignments.sessionId} = ${learningSessions.id} and ${reviews.status} = 'done' and ${reviews.reviewedAt} > ${last})`,
      ),
    )
    .orderBy(asc(learningSessions.closedAt), asc(learningSessions.id));
}

/**
 * The evidence since the last refresh (method.md, "Refreshing the teaching notes"): for each
 * session, its checks and repairs, its asides, its homework and recap with the learner's replies,
 * and the review of what it assigned; for each session closed before but reviewed since
 * (`reviewedLater`), that review alone. Each session is labelled S1, S2…, for the notes to cite;
 * `labels` maps them back.
 */
export async function profileEvidence(
  db: Db,
  sessions: readonly ClosedSession[],
  reviewedLater: readonly ClosedSession[] = [],
): Promise<{ text: string; labels: Map<string, string> }> {
  const labels = new Map<string, string>();
  const all = [...sessions, ...reviewedLater];
  const titles = new Map(
    all.length
      ? (
          await db
            .select({ id: tracks.id, title: tracks.title })
            .from(tracks)
            .where(inArray(tracks.id, [...new Set(all.map((s) => s.trackId))]))
        ).map((t) => [t.id, t.title])
      : [],
  );
  const parts: string[] = [];
  for (const [index, session] of all.entries()) {
    const label = `S${String(index + 1)}`;
    labels.set(label, session.id);
    const day = (session.closedAt ?? session.createdAt).toISOString().slice(0, 10);
    const later = index >= sessions.length ? " (only what was handed in since)" : "";
    const sections = [`## ${label}: ${titles.get(session.trackId) ?? "A track"}, ${day}${later}`];
    if (!later) {
      const checks = await loadCheckRecord(db, session.id, session.state);
      if (checks) sections.push(`### What happened at the lesson's checks\n\n${checks}`);
      const asked = await asidesRecord(db, session.id);
      if (asked) sections.push(`### ${ASKED_IN_THE_MARGIN}\n\n${asked}`);
      const after = await afterTheLesson(db, session.id);
      if (after) sections.push(`### The homework and the recap\n\n${after}`);
    }
    const reviewed = await sessionReviewRecord(db, session.id);
    if (reviewed) sections.push(`### ${HOMEWORK_REVIEWED}\n\n${reviewed}`);
    parts.push(sections.join("\n\n"));
  }
  return { text: parts.join("\n\n"), labels };
}

/** The session's chat from its homework on: the homework, the learner's replies, the recap. */
async function afterTheLesson(db: Db, sessionId: string): Promise<string | null> {
  const messages = await db
    .select()
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(asc(sessionMessages.createdAt), asc(sessionMessages.id));
  const from = messages.findIndex((m) => m.kind === "homework" || m.kind === "recap");
  if (from === -1) return null;
  return messages
    .slice(from)
    .map((m) => `${m.role === "learner" ? "Learner" : "Tutor"}: ${m.text ?? ""}`)
    .join("\n\n");
}

/** A note as it stands: its id, text and evidence. */
export interface CurrentNote {
  id: string;
  text: string;
  evidence: NoteEvidence[];
  /** The learner wrote it, or edited it since a refresh last did. */
  byLearner: boolean;
}

/** What a refresh changes: notes revised (or kept as they are), removed and added. */
export interface NoteChanges {
  revised: { id: string; text: string; evidence: NoteEvidence[] }[];
  removed: string[];
  added: { text: string; evidence: NoteEvidence[] }[];
}

/** Sessions a new note must rest on (method.md): a pattern, not one bad day. */
export const PATTERN_SESSIONS = 3;

/**
 * The refresh's notes as changes to the current ones (labelled N1, N2… in its prompt). Evidence
 * citing no session of the refresh is dropped; a kept note adds its new evidence to its old; a new
 * note resting on fewer than three sessions is left out, and so is any past about a dozen.
 */
export function settleNotes(
  current: readonly CurrentNote[],
  refresh: TeachingNotesRefresh,
  labels: ReadonlyMap<string, string>,
): NoteChanges {
  const byLabel = new Map(current.map((note, i) => [`N${String(i + 1)}`, note]));
  const kept = new Set<string>();
  const changes: NoteChanges = { revised: [], removed: [], added: [] };
  for (const note of refresh.notes) {
    const text = note.text.trim();
    if (!text) continue;
    const cited = note.evidence.flatMap((e) => {
      const sessionId = labels.get(e.session.trim());
      return sessionId ? [{ sessionId, what: e.what.trim() }] : [];
    });
    const old = note.keeps ? byLabel.get(note.keeps.trim()) : undefined;
    if (old && !kept.has(old.id)) {
      kept.add(old.id);
      const known = new Set(old.evidence.map((e) => e.sessionId));
      changes.revised.push({
        id: old.id,
        text,
        evidence: [...old.evidence, ...cited.filter((e) => !known.has(e.sessionId))],
      });
    } else if (new Set(cited.map((e) => e.sessionId)).size >= PATTERN_SESSIONS) {
      changes.added.push({ text, evidence: cited });
    }
  }
  changes.added = changes.added.slice(0, Math.max(0, TEACHING_NOTES_MAX - changes.revised.length));
  changes.removed = current.filter((n) => !kept.has(n.id)).map((n) => n.id);
  return changes;
}

/** Whether the close of a session is the time to refresh the learner's notes (design §8). */
export async function profileDue(db: Db, userId: string): Promise<boolean> {
  const refreshed = (await lastRefresh(db, userId)) !== null;
  const closed = (await sessionsSinceRefresh(db, userId)).length;
  return closed >= (refreshed ? REFRESH_EVERY : FIRST_REFRESH_AFTER);
}

const REFRESH_REQUEST =
  "(For the app; the learner doesn't see this.) Refresh the learner's teaching notes from the evidence above: every note as it should now stand.";

/** The current notes as the refresh reads them: labelled, with what they rested on. */
function currentNotesText(notes: readonly CurrentNote[]): string {
  if (notes.length === 0) return "None yet.";
  return notes
    .map((note, i) => {
      const shown = note.evidence.map((e) => e.what).filter(Boolean);
      const rests = shown.length ? `\n  Seen before: ${shown.join("; ")}` : "";
      const own = note.byLearner ? " (the learner wrote or edited it)" : "";
      return `N${String(i + 1)}: ${note.text}${own}${rests}`;
    })
    .join("\n");
}

/**
 * Refreshes the learner's notes at the close of `sessionId` (design §8), and records the refresh,
 * changed or not. Another refresh that finished meanwhile wins: this one then writes nothing. A
 * note the learner edited meanwhile is left as they left it.
 */
export async function refreshTeachingNotes(options: {
  db: Db;
  models: ModelAccess;
  method: Method;
  userId: string;
  sessionId: string;
}): Promise<void> {
  const { db, models, method, userId, sessionId } = options;
  const started = await lastRefresh(db, userId);
  const current = await db
    .select()
    .from(learnerProfileNotes)
    .where(eq(learnerProfileNotes.userId, userId))
    .orderBy(asc(learnerProfileNotes.createdAt), asc(learnerProfileNotes.id));
  const evidence = await profileEvidence(
    db,
    await sessionsSinceRefresh(db, userId),
    await reviewedSinceRefresh(db, userId),
  );
  const system = systemMessages(
    assembleSystemPrompt(method, "profile", {
      extra: [
        { heading: "The learner's current teaching notes", body: currentNotesText(current) },
        { heading: "The evidence since the last refresh", body: evidence.text },
      ],
    }),
  );
  const model = await models.model({ userId, sessionId, purpose: "profile", role: "strong" });
  const { output } = await generateText({
    model,
    system,
    output: Output.object({ schema: teachingNotesSchema }),
    prompt: REFRESH_REQUEST,
  });
  const changes = settleNotes(current, output, evidence.labels);
  const written = await db.transaction(async (tx) => {
    // One refresh at a time per learner: two tracks may close at once.
    await tx.execute(sql`select pg_advisory_xact_lock(${PROFILE_LOCK}, hashtext(${userId}))`);
    if ((await lastRefresh(tx, userId)) !== started) return false;
    // A note the learner changed since it was read is theirs now: the refresh leaves it be.
    const now = await tx
      .select({ id: learnerProfileNotes.id, revisedAt: learnerProfileNotes.revisedAt })
      .from(learnerProfileNotes)
      .where(eq(learnerProfileNotes.userId, userId));
    const read = new Map(current.map((n) => [n.id, n.revisedAt.getTime()]));
    const untouched = new Set(
      now.filter((n) => read.get(n.id) === n.revisedAt.getTime()).map((n) => n.id),
    );
    const removed = changes.removed.filter((id) => untouched.has(id));
    if (removed.length)
      await tx.delete(learnerProfileNotes).where(inArray(learnerProfileNotes.id, removed));
    for (const note of changes.revised) {
      if (!untouched.has(note.id)) continue;
      const before = current.find((n) => n.id === note.id);
      const changed = before?.text !== note.text;
      await tx
        .update(learnerProfileNotes)
        .set({
          evidence: note.evidence,
          ...(changed ? { text: note.text, revisedAt: sql`now()`, byLearner: false } : {}),
        })
        .where(eq(learnerProfileNotes.id, note.id));
    }
    if (changes.added.length)
      await tx
        .insert(learnerProfileNotes)
        .values(changes.added.map((note) => ({ userId, ...note })));
    await tx.insert(profileRefreshes).values({ userId, sessionId });
    return true;
  });
  log.info(
    written
      ? {
          revised: changes.revised.length,
          removed: changes.removed.length,
          added: changes.added.length,
        }
      : {},
    written ? "teaching notes refreshed" : "another refresh finished first; this one is dropped",
  );
}

/**
 * The profile job, queued at a session's close when a refresh is due. A failure the learner's key
 * or provider explains leaves the notes as they were; the next close tries again, as it is still due.
 */
export function createProfileTasks(deps: {
  db: Db;
  models: ModelAccess;
  method: Method;
}): TaskList {
  return {
    profile: async (payload) => {
      const { sessionId } = payload as { sessionId: string };
      const [session] = await deps.db
        .select({ userId: learningSessions.userId })
        .from(learningSessions)
        .where(eq(learningSessions.id, sessionId));
      if (!session) return;
      addLogContext({ userId: session.userId, sessionId });
      try {
        await refreshTeachingNotes({ ...deps, userId: session.userId, sessionId });
      } catch (error) {
        if (!(error instanceof ProviderCallError || error instanceof NoCredentialError))
          throw error;
        reportHandledFailure(error);
      }
    },
  };
}

/** The advisory lock class of profile refreshes; the second key is the learner id's hash. */
const PROFILE_LOCK = 1_735_552_613;
