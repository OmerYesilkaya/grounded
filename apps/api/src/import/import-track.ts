import { importActionsSchema, type ImportActions, type TrackAction } from "@grounded/core";
import {
  and,
  credentials,
  eq,
  importedLessons,
  sql,
  tracks,
  users,
  type Db,
  type TermStatus,
} from "@grounded/db";
import {
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  streamText,
  type ModelMessage,
} from "ai";
import { normalizeEmail } from "../allowlist.js";
import { callLimitsFor, type CallLimits } from "../engine/call-limits.js";
import type { ModelAccess } from "../engine/model-call.js";
import { applyActions, emptyTrackShape, validateActions } from "../engine/track-state.js";
import { readLearningTrack, type LearningTrack } from "./learning-folder.js";
import { composePlanNotes, stateSection } from "./notes.js";
import { IMPORT_SYSTEM, importPrompt } from "./prompt.js";

/** One call, plus bounded retries only when the edits are rejected. */
export const IMPORT_ATTEMPTS = 3;

/**
 * Time limits for the import's call (see call-limits.ts). A whole track's edits are tens of thousands
 * of tokens written in one stream, far past a session call's limits; silences stay bounded so a hung
 * connection still ends.
 */
export const IMPORT_CALL_LIMITS: CallLimits = {
  generateMs: 180 * 1000,
  streamMs: 30 * 60 * 1000,
  thinkMs: 180 * 1000,
  idleMs: 60 * 1000,
};

export const importCallLimitsFor = (purpose: string): CallLimits =>
  purpose === "import" ? IMPORT_CALL_LIMITS : callLimitsFor(purpose);

export interface ImportOptions {
  db: Db;
  models: ModelAccess;
  /** The track's folder in the earlier setup (it holds state.md). */
  folder: string;
  email: string;
  /** Apply it; otherwise a dry run that writes nothing. */
  write: boolean;
  /** Overrides the title taken from the track's folder name. */
  title?: string;
}

export interface ImportReport {
  folder: string;
  email: string;
  written: boolean;
  trackId: string | null;
  title: string;
  language: string | null;
  termCounts: Record<TermStatus, number>;
  dependencies: number;
  arcs: { title: string; terms: number }[];
  fixItems: string[];
  notesLength: number;
  openThreads: string | null;
  owedHomework: { folder: string; length: number } | null;
  otherUnansweredHomework: string[];
  latestLesson: { folder: string; title: string; length: number } | null;
  unplaced: string[];
  /** Parts of the earlier state the import expected and didn't find. */
  missing: string[];
  attempts: number;
}

export type ImportOutcome =
  | { status: "refused"; reason: string }
  | { status: "rejected"; attempts: number; errors: string[] }
  | { status: "ok"; report: ImportReport };

/**
 * The one-time import of a track kept in the learner's earlier setup (design §10). The model turns
 * the state into the same edits a session makes; the edits are validated against an empty track, and
 * only a write applies them, with the latest lesson, to a new track.
 */
export async function importTrack(options: ImportOptions): Promise<ImportOutcome> {
  const { db, models } = options;
  const email = normalizeEmail(options.email);
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) return refused(`No learner signed up as ${email}. They sign in once first.`);
  const [credential] = await db.select().from(credentials).where(eq(credentials.userId, user.id));
  if (!credential)
    return refused(`${email} has no AI key. The import runs on their model: add one in Settings.`);

  const track = await readLearningTrack(options.folder);
  const title = options.title?.trim() ? options.title.trim() : track.title;
  const [duplicate] = await db
    .select({ id: tracks.id })
    .from(tracks)
    .where(and(eq(tracks.userId, user.id), sql`lower(${tracks.title}) = lower(${title})`));
  if (duplicate) return refused(`${email} already has a track called "${title}".`);

  const converted = await convert(models, user.id, track);
  if (!converted.ok)
    return { status: "rejected", attempts: converted.attempts, errors: converted.errors };

  const notes = composePlanNotes(converted.planNotes, track);
  const actions = converted.actions.map((a) => (a.type === "set-plan" ? { ...a, notes } : a));
  const report = reportOf(options, track, title, actions, notes, converted);
  if (!options.write) return { status: "ok", report };

  const trackId = await write(db, user.id, title, track, actions);
  return { status: "ok", report: { ...report, written: true, trackId } };
}

const refused = (reason: string): ImportOutcome => ({ status: "refused", reason });

type Conversion =
  | {
      ok: true;
      actions: TrackAction[];
      planNotes: string;
      unplaced: string[];
      attempts: number;
    }
  | { ok: false; errors: string[]; attempts: number };

async function convert(
  models: ModelAccess,
  userId: string,
  track: LearningTrack,
): Promise<Conversion> {
  const messages: ModelMessage[] = [{ role: "user", content: importPrompt(track) }];
  let errors: string[] = [];
  for (let attempt = 1; attempt <= IMPORT_ATTEMPTS; attempt++) {
    const model = await models.model({ userId, purpose: "import", role: "strong" });
    // Streamed: a whole track's edits take minutes to write, longer than a plain request may stay open.
    let streamError: Error | undefined;
    const result = streamText({
      model,
      system: IMPORT_SYSTEM,
      messages,
      output: Output.object({ schema: importActionsSchema }),
      onError: ({ error }) => {
        streamError ??= error instanceof Error ? error : new Error("The model's reply failed.");
      },
    });
    let output: ImportActions;
    try {
      output = await result.output;
    } catch (error) {
      // A failed stream also ends in "no object"; only a reply that came back whole is worth a retry.
      if (streamError) throw streamError;
      if (!NoObjectGeneratedError.isInstance(error) && !NoOutputGeneratedError.isInstance(error))
        throw error;
      errors = ["The reply wasn't a complete object in the requested shape."];
      messages.push({ role: "user", content: retryPrompt(errors) });
      continue;
    }
    errors = importProblems(output.actions);
    if (errors.length === 0) {
      const plan = output.actions.find((a) => a.type === "set-plan");
      return {
        ok: true,
        actions: output.actions,
        planNotes: plan?.type === "set-plan" ? plan.notes : "",
        unplaced: output.unplaced,
        attempts: attempt,
      };
    }
    messages.push(
      { role: "assistant", content: JSON.stringify(output) },
      { role: "user", content: retryPrompt(errors) },
    );
  }
  return { ok: false, errors, attempts: IMPORT_ATTEMPTS };
}

const retryPrompt = (errors: string[]) =>
  `Those edits were rejected:\n${errors.map((e) => `- ${e}`).join("\n")}\nReturn the whole batch again, fixed.`;

/** What the track's validator checks, plus what an import needs: a language and exactly one plan. */
export function importProblems(actions: readonly TrackAction[]): string[] {
  const shape = emptyTrackShape();
  const errors = validateActions(shape, actions);
  if (!actions.some((a) => a.type === "set-language"))
    errors.push("Set the teaching language (set-language).");
  const plans = actions.filter((a) => a.type === "set-plan");
  if (plans.length !== 1)
    errors.push(`Give exactly one set-plan with the arcs (there were ${String(plans.length)}).`);
  for (const plan of plans)
    for (const arc of plan.arcs)
      for (const term of arc.terms)
        if (!shape.terms.has(term.trim().toLowerCase()))
          errors.push(`Arc "${arc.title}" lists "${term}", which isn't in the term list.`);
  return errors;
}

/** Track, latest lesson and edits; a failure part-way removes the track again, with everything on it. */
async function write(
  db: Db,
  userId: string,
  title: string,
  track: LearningTrack,
  actions: readonly TrackAction[],
): Promise<string> {
  const [row] = await db.insert(tracks).values({ userId, title }).returning();
  if (!row) throw new Error("track insert returned nothing");
  try {
    if (track.latestLesson) {
      await db.insert(importedLessons).values({
        trackId: row.id,
        title: track.latestLesson.title,
        source: track.latestLesson.folder,
        html: track.latestLesson.html,
      });
    }
    const applied = await applyActions(db, row.id, actions, {
      source: `imported from Learning ${track.snapshotDate ?? ""}`.trim(),
    });
    if (!applied.ok) throw new Error(`the edits were rejected: ${applied.errors.join("; ")}`);
  } catch (error) {
    await db.delete(tracks).where(eq(tracks.id, row.id));
    throw error;
  }
  return row.id;
}

function reportOf(
  options: ImportOptions,
  track: LearningTrack,
  title: string,
  actions: readonly TrackAction[],
  notes: string,
  conversion: { unplaced: string[]; attempts: number },
): ImportReport {
  const statuses = new Map<string, TermStatus>();
  let dependencies = 0;
  let language: string | null = null;
  const fixItems: string[] = [];
  let arcs: ImportReport["arcs"] = [];
  for (const action of actions) {
    const key = "term" in action ? action.term.trim().toLowerCase() : "";
    switch (action.type) {
      case "add-planned-term":
        statuses.set(key, "planned");
        dependencies += action.restsOn.length;
        break;
      case "set-term-status":
        statuses.set(key, action.status);
        break;
      case "set-language":
        language = action.language;
        break;
      case "add-fix-item":
        fixItems.push(action.text);
        break;
      case "close-fix-item":
        break;
      case "set-plan":
        arcs = action.arcs.map((a) => ({ title: a.title, terms: a.terms.length }));
        break;
    }
  }
  const termCounts: Record<TermStatus, number> = {
    assumed: 0,
    confirmed: 0,
    taught: 0,
    planned: 0,
  };
  for (const status of statuses.values()) termCounts[status]++;

  const openThreads = stateSection(track, "open threads");
  const missing = [
    ...(["ledger", "map", "plan", "session log", "open threads"] as const)
      .filter((prefix) => stateSection(track, prefix) === null)
      .map((prefix) => `state.md has no "${prefix}" section`),
    ...(track.handoff === null ? ["no handoff.md"] : []),
    ...(track.readmeRow === null ? ["no row for the track in ../README.md"] : []),
    ...(track.latestLesson === null ? ["no lesson.html in any session folder"] : []),
  ];
  return {
    folder: options.folder,
    email: normalizeEmail(options.email),
    written: false,
    trackId: null,
    title,
    language,
    termCounts,
    dependencies,
    arcs,
    fixItems,
    notesLength: notes.length,
    openThreads,
    owedHomework: track.owedHomework
      ? { folder: track.owedHomework.folder, length: track.owedHomework.text.length }
      : null,
    otherUnansweredHomework: track.otherUnansweredHomework,
    latestLesson: track.latestLesson
      ? {
          folder: track.latestLesson.folder,
          title: track.latestLesson.title,
          length: track.latestLesson.html.length,
        }
      : null,
    unplaced: conversion.unplaced,
    missing,
    attempts: conversion.attempts,
  };
}
