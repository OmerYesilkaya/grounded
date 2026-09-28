import { createHash } from "node:crypto";
import { importReadingSchema, type ImportReading, type TrackAction } from "@grounded/core";
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
import { buildEdits } from "./edits.js";
import { readLearningTrack, type LearningTrack } from "./learning-folder.js";
import { mergeLedger, type LedgerTerm } from "./ledger.js";
import { composePlanNotes, stateSection } from "./notes.js";
import { IMPORT_SYSTEM, importPrompt } from "./prompt.js";

/** One call, plus bounded retries only when the reply isn't a whole object in the requested shape. */
export const IMPORT_ATTEMPTS = 3;

/**
 * Time limits for the import's call (see call-limits.ts). Reading a whole track's map and plan takes
 * longer than a session call; silences stay bounded so a hung connection still ends.
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
  /** For a write: the dry run's conversion, applied as it was reviewed (no model call). */
  reviewed?: ReviewedConversion;
}

/**
 * A dry run's result, kept so that a write applies exactly what was reviewed. `sourceHash` pins it to
 * the files it was made from; a write refuses if they changed.
 */
/** Bumped when a saved dry run from an earlier importer can no longer be applied as it is. */
export const CONVERSION_VERSION = 2;

export interface ReviewedConversion {
  version: number;
  slug: string;
  sourceHash: string;
  actions: TrackAction[];
  /** The model's own plan notes, before the earlier setup's words are appended. */
  planNotes: string;
  unplaced: string[];
  attempts: number;
}

export interface ImportReport {
  folder: string;
  email: string;
  written: boolean;
  trackId: string | null;
  title: string;
  language: string | null;
  termCounts: Record<TermStatus, number>;
  /** Rows and items per ledger section as parsed, before duplicates were merged. */
  ledgerCounts: Record<TermStatus, number>;
  /** Terms listed in more than one section, and the status kept. */
  merged: string[];
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
  | { status: "ok"; report: ImportReport; conversion: ReviewedConversion };

/**
 * The one-time import of a track kept in the learner's earlier setup (design §10). The ledger's terms,
 * statuses and evidence are parsed; one model call reads the map, the plan and the open threads for
 * dependencies, arcs and the fix-list. Only a write applies the edits, with the latest lesson, to a
 * new track.
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

  const terms = mergeLedger(track.ledger.entries);
  const sourceHash = hashSource(track);
  let conversion: ReviewedConversion;
  if (options.write) {
    // What was reviewed is what gets written: no second model call, which could read differently.
    const { reviewed } = options;
    if (!reviewed) {
      return refused(
        "There is no reviewed dry run. Run it without --write first; --write applies exactly what it showed.",
      );
    }
    if (reviewed.version !== CONVERSION_VERSION) {
      return refused(
        "The saved dry run was made by an earlier version of the importer. Run the dry run again.",
      );
    }
    if (reviewed.sourceHash !== sourceHash || reviewed.slug !== track.slug) {
      return refused("The earlier setup's files changed since the dry run. Run the dry run again.");
    }
    conversion = reviewed;
  } else {
    const read = await readTrack(models, user.id, track, terms);
    if (!read.ok) return { status: "rejected", attempts: read.attempts, errors: read.errors };
    const edits = buildEdits(terms, read.reading);
    const problems = importProblems(edits.actions);
    if (problems.length > 0) {
      // The edits are built to be valid; a rejection here is the importer's bug, not the model's.
      throw new Error(
        `The importer built edits that don't validate (a bug in the importer):\n${problems.map((p) => `  - ${p}`).join("\n")}`,
      );
    }
    conversion = {
      version: CONVERSION_VERSION,
      slug: track.slug,
      sourceHash,
      actions: edits.actions,
      planNotes: read.reading.planNotes.trim(),
      unplaced: edits.unplaced,
      attempts: read.attempts,
    };
  }

  const notes = composePlanNotes(conversion.planNotes, track, terms);
  const actions = conversion.actions.map((a) => (a.type === "set-plan" ? { ...a, notes } : a));
  const report = reportOf(options, track, title, terms, actions, notes, conversion);
  if (!options.write) return { status: "ok", report, conversion };

  const trackId = await write(db, user.id, title, track, actions);
  return { status: "ok", report: { ...report, written: true, trackId }, conversion };
}

const refused = (reason: string): ImportOutcome => ({ status: "refused", reason });

type Reading =
  | { ok: true; reading: ImportReading; attempts: number }
  | { ok: false; errors: string[]; attempts: number };

/** The one model call; asked again only when the reply isn't a whole object in the requested shape. */
async function readTrack(
  models: ModelAccess,
  userId: string,
  track: LearningTrack,
  terms: readonly LedgerTerm[],
): Promise<Reading> {
  const messages: ModelMessage[] = [{ role: "user", content: importPrompt(track, terms) }];
  const errors = ["The reply wasn't a complete object in the requested shape."];
  for (let attempt = 1; attempt <= IMPORT_ATTEMPTS; attempt++) {
    const model = await models.model({ userId, purpose: "import", role: "strong" });
    // Streamed: a long reply can take longer than a plain request may stay open.
    let streamError: Error | undefined;
    const result = streamText({
      model,
      system: IMPORT_SYSTEM,
      messages,
      output: Output.object({ schema: importReadingSchema }),
      onError: ({ error }) => {
        streamError ??= error instanceof Error ? error : new Error("The model's reply failed.");
      },
    });
    try {
      return { ok: true, reading: await result.output, attempts: attempt };
    } catch (error) {
      // A failed stream also ends in "no object"; only a reply that came back whole is worth a retry.
      if (streamError) throw streamError;
      if (!NoObjectGeneratedError.isInstance(error) && !NoOutputGeneratedError.isInstance(error))
        throw error;
      messages.push({
        role: "user",
        content: `${errors.join("\n")}\nReturn the whole answer again, in the requested shape.`,
      });
    }
  }
  return { ok: false, errors, attempts: IMPORT_ATTEMPTS };
}

/** What the track's validator checks, plus what an import needs: a language and exactly one plan. */
export function importProblems(actions: readonly TrackAction[]): string[] {
  const errors = validateActions(emptyTrackShape(), actions);
  if (!actions.some((a) => a.type === "set-language"))
    errors.push("Set the teaching language (set-language).");
  const plans = actions.filter((a) => a.type === "set-plan");
  if (plans.length !== 1)
    errors.push(`Give exactly one set-plan with the arcs (there were ${String(plans.length)}).`);
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
  const [row] = await db.insert(tracks).values({ userId, title, goal: title }).returning();
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
  terms: readonly LedgerTerm[],
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
    ledgerCounts: track.ledger.counts,
    merged: terms
      .filter((t) => t.alsoIn.length > 0)
      .map((t) => `${t.term}: ${t.status} (also listed as ${t.alsoIn.join(", ")})`),
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
    unplaced: [...track.ledger.skipped, ...conversion.unplaced],
    missing,
    attempts: conversion.attempts,
  };
}

/** A fingerprint of everything the conversion is made from. */
function hashSource(track: LearningTrack): string {
  const hash = createHash("sha256");
  for (const part of [
    track.state,
    track.handoff,
    track.readmeRow,
    track.latestLesson?.html,
    track.owedHomework?.text,
  ]) {
    hash.update(part ?? "\u0000");
    hash.update("\u0001");
  }
  return hash.digest("hex");
}
