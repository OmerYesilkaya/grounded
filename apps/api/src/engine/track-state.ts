import {
  NOTES_PHASES,
  selectTrackView,
  WHOLE_PLAN_PHASES,
  type FixItem,
  type Phase,
  type PromptContext,
  type TermRow,
  type TrackAction,
} from "@grounded/core";
import {
  and,
  desc,
  eq,
  fixListItems,
  inArray,
  isNull,
  learningSessions,
  sql,
  termDependencies,
  termEvents,
  terms,
  trackFiles,
  tracks,
  type Db,
  type TermStatus,
  type TrackPlan,
} from "@grounded/db";
import type { TrackTerm } from "@grounded/content";
import { content, log } from "../log.js";

export type ApplyResult = { ok: true } | { ok: false; errors: string[] };

export interface KnownTerm {
  id: string | null;
  term: string;
  status: TermStatus;
}

const key = (term: string) => term.trim().toLowerCase();

type Arcs = TrackPlan["arcs"];

/**
 * What the track looks like to the validator: its terms by lowercased name, its open fix-list
 * items, and the plan's arcs and notes.
 */
export interface TrackShape {
  terms: Map<string, KnownTerm>;
  openFixItems: Set<string>;
  arcs: Arcs;
  notes: string;
  /** What the learner holds in their other tracks, by lowercased name: what borrow-term may borrow. */
  heldElsewhere: Map<string, HeldTerm>;
}

/** An empty track: the shape a batch is validated against before the track exists (an import). */
export function emptyTrackShape(): TrackShape {
  return {
    terms: new Map(),
    openFixItems: new Set(),
    arcs: [],
    notes: "",
    heldElsewhere: new Map(),
  };
}

/** The edits only a call that saw the whole plan may make (`rewritePlan` on applyActions). */
const PLAN_REWRITES: ReadonlySet<TrackAction["type"]> = new Set(["set-plan", "edit-plan-notes"]);

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*$/;
const FENCE = /^\s*(```|~~~)/;

/** A heading line's level and its text as matched: case and runs of spaces don't count. */
function headingOf(line: string): { level: number; match: string } | null {
  const found = HEADING.exec(line.trim());
  if (!found?.[1] || !found[2]) return null;
  const level = found[1].length;
  return { level, match: `${String(level)} ${found[2].replace(/\s+/g, " ").toLowerCase()}` };
}

/**
 * An edit-plan-notes applied to the notes (design §5), or why it can't be. A section is its heading
 * line and everything up to the next heading of its level or above (so its subsections with it);
 * headings inside code fences don't count. `text` replaces the section's body under its heading,
 * null removes the section, and a heading no section has adds a new section at the end. Pure.
 */
export function editNotesSection(
  notes: string,
  edit: { heading: string; text: string | null },
): { notes: string } | { code: RejectionCode; reason: string } {
  const heading = headingOf(edit.heading);
  if (!heading)
    return {
      code: "not-a-heading",
      reason: `edit-plan-notes needs a section's heading line as the notes write it, like "## Open threads"; "${edit.heading}" isn't one.`,
    };
  const lines = notes.split("\n");
  let fenced = false;
  const headings: { at: number; level: number; match: string }[] = [];
  lines.forEach((line, at) => {
    if (FENCE.test(line)) fenced = !fenced;
    const found = fenced ? null : headingOf(line);
    if (found) headings.push({ at, ...found });
  });
  const matches = headings.filter((h) => h.match === heading.match);
  const text = edit.text?.trim() ?? null;
  const section = (line: string) => (text ? `${line}\n\n${text}` : line);
  const [found, ...more] = matches;
  if (!found) {
    if (text === null)
      return {
        code: "no-section",
        reason: `The plan's notes have no section "${edit.heading.trim()}" to remove.`,
      };
    return {
      notes: [notes.trimEnd(), section(edit.heading.trim())].filter(Boolean).join("\n\n"),
    };
  }
  if (more.length > 0)
    return {
      code: "ambiguous-section",
      reason: `The plan's notes have ${String(matches.length)} sections "${edit.heading.trim()}"; edit the section that holds the one you mean.`,
    };
  const end = headings.find((h) => h.at > found.at && h.level <= found.level)?.at ?? lines.length;
  return {
    notes: [
      lines.slice(0, found.at).join("\n").trimEnd(),
      edit.text === null ? "" : section(lines[found.at]?.trim() ?? ""),
      lines.slice(end).join("\n").trim(),
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

/**
 * An add-to-arc applied to the arcs (design §4.4): its terms appended to the arc with its title
 * (matched case-insensitively), or to a new arc at the end when none has it. Nothing is removed or
 * reordered. A term already in an arc (this one or another) stays where it is and is skipped, so a
 * revised plan that places its terms again changes nothing. Terms are written as `nameOf` spells
 * them (the term list's spelling). Pure; returns the new arcs and the terms skipped.
 */
export function addToArc(
  arcs: Arcs,
  action: { arc: string; terms: readonly string[] },
  nameOf: (term: string) => string = (term) => term.trim(),
): { arcs: Arcs; skipped: string[] } {
  const placed = new Set(arcs.flatMap((arc) => arc.terms.map(key)));
  const fresh: string[] = [];
  const skipped: string[] = [];
  for (const term of action.terms) {
    if (placed.has(key(term))) {
      skipped.push(term);
    } else {
      placed.add(key(term));
      fresh.push(nameOf(term));
    }
  }
  if (fresh.length === 0) return { arcs, skipped };
  const at = arcs.findIndex((arc) => key(arc.title) === key(action.arc));
  if (at === -1) return { arcs: [...arcs, { title: action.arc.trim(), terms: fresh }], skipped };
  return {
    arcs: arcs.map((arc, i) => (i === at ? { ...arc, terms: [...arc.terms, ...fresh] } : arc)),
    skipped,
  };
}

/** Why an edit was rejected, for logs that mustn't quote the term names and fix-list items it names. */
export type RejectionCode =
  | "unknown-term"
  | "no-evidence"
  | "unknown-rests-on"
  | "no-open-fix-item"
  | "no-language"
  | "empty-arc"
  | "unplaced-term"
  | "not-a-heading"
  | "no-section"
  | "ambiguous-section"
  | "not-held-elsewhere";

/** An edit of a batch that doesn't validate: which one (its index in the batch) and why. */
export interface Rejection {
  index: number;
  code: RejectionCode;
  /** What the model can act on; it quotes the edit's term names and fix-list items. */
  reason: string;
}

/**
 * Checks a batch against the track as it would be after each edit, without writing anything. Returns
 * the edits that don't validate, with reasons the model can act on; empty when the whole batch is
 * valid. The shape is updated in place by the valid edits only, so the batch without the rejected
 * edits is valid too (an edit that needs a rejected one, like a status for a term whose adding was
 * rejected, is rejected with it). An add-to-arc's terms are checked against the term list as the
 * whole batch leaves it, so a batch may place a term before the edit that adds it.
 */
export function validateActions(shape: TrackShape, actions: readonly TrackAction[]): Rejection[] {
  const { terms: known, openFixItems } = shape;
  const rejections: Rejection[] = [];
  const placed: { index: number; arc: string; term: string }[] = [];
  actions.forEach((action, index) => {
    const reject = (code: RejectionCode, reason: string) => {
      rejections.push({ index, code, reason });
    };
    switch (action.type) {
      case "set-term-status": {
        const term = known.get(key(action.term));
        if (!term && action.status !== "assumed") {
          reject(
            "unknown-term",
            `"${action.term}" isn't in the term list; add it as a planned term first (or as assumed, if the learner already knew it).`,
          );
        } else if (!action.evidence.trim()) {
          reject(
            "no-evidence",
            `Changing "${term?.term ?? action.term}" needs the learner's words as evidence.`,
          );
        } else {
          known.set(key(action.term), {
            id: term?.id ?? null,
            term: term?.term ?? action.term.trim(),
            status: action.status,
          });
        }
        break;
      }
      case "add-planned-term": {
        const missing = action.restsOn.find((r) => !known.has(key(r)));
        if (missing) {
          reject(
            "unknown-rests-on",
            `"${action.term}" rests on "${missing}", which isn't in the term list.`,
          );
          break;
        }
        // A term already in the list keeps its status; only what it rests on is added (#19).
        if (!known.has(key(action.term)))
          known.set(key(action.term), { id: null, term: action.term.trim(), status: "planned" });
        break;
      }
      case "close-fix-item":
        if (!openFixItems.has(action.text))
          reject("no-open-fix-item", `There is no open fix-list item "${action.text}".`);
        else openFixItems.delete(action.text);
        break;
      case "add-fix-item":
        openFixItems.add(action.text);
        break;
      case "set-language":
        if (!action.language.trim())
          reject("no-language", "set-language needs the name of a language.");
        break;
      case "add-to-arc":
        if (action.terms.length === 0) {
          reject("empty-arc", `add-to-arc "${action.arc}" names no terms.`);
          break;
        }
        placed.push(...action.terms.map((term) => ({ index, arc: action.arc, term })));
        shape.arcs = addToArc(shape.arcs, action).arcs;
        break;
      case "set-plan":
        shape.arcs = action.arcs;
        if (action.notes !== null) shape.notes = action.notes;
        break;
      case "edit-plan-notes": {
        const edited = editNotesSection(shape.notes, action);
        if ("code" in edited) reject(edited.code, edited.reason);
        else shape.notes = edited.notes;
        break;
      }
      case "add-plan-notes":
        shape.notes = addedNotes(shape.notes, action.notes);
        break;
      case "borrow-term": {
        if (!shape.heldElsewhere.has(key(action.from))) {
          reject(
            "not-held-elsewhere",
            `"${action.from}" isn't held in any of the learner's other tracks; plan "${action.term}" as a term to teach instead.`,
          );
          break;
        }
        // A term this track already has keeps its own status unless it is only planned (#54).
        const here = known.get(key(action.term));
        if (!here || here.status === "planned")
          known.set(key(action.term), {
            id: here?.id ?? null,
            term: here?.term ?? action.term.trim(),
            status: "confirmed",
          });
        break;
      }
    }
  });
  for (const { index, arc, term } of placed) {
    if (!known.has(key(term)))
      rejections.push({
        index,
        code: "unplaced-term",
        reason: `"${term}" isn't in the term list; add it as a planned term to place it in "${arc}".`,
      });
  }
  return rejections.toSorted((a, b) => a.index - b.index);
}

/** An edit of a batch applied in part that was rejected: the edit, and why. */
export interface RejectedAction extends Rejection {
  action: TrackAction;
}

interface CheckedBatch {
  actions: readonly TrackAction[];
  /** The track as the batch's valid edits leave it. */
  shape: TrackShape;
  existing: (typeof terms.$inferSelect)[];
  rejected: RejectedAction[];
}

/** Checks a batch against the track as it is now (applyActions says what `rewritePlan` is). */
async function checkBatch(
  db: Db,
  trackId: string,
  batch: readonly TrackAction[],
  options: { source: string; rewritePlan?: boolean },
): Promise<CheckedBatch> {
  const allowed = options.rewritePlan
    ? batch
    : batch.filter((action) => !PLAN_REWRITES.has(action.type));
  // Borrowed terms first, so a planned term may rest on one borrowed later in the batch.
  const actions = [
    ...allowed.filter((a) => a.type === "borrow-term"),
    ...allowed.filter((a) => a.type !== "borrow-term"),
  ];
  if (actions.length < batch.length)
    log.info(
      { trackId, source: options.source, dropped: batch.length - actions.length },
      "plan rewrites left out: this call may not rewrite the plan",
    );
  const existing = await db.select().from(terms).where(eq(terms.trackId, trackId));
  const openFixItems = await db
    .select()
    .from(fixListItems)
    .where(and(eq(fixListItems.trackId, trackId), eq(fixListItems.status, "open")));
  const [track] = await db.select({ plan: tracks.plan }).from(tracks).where(eq(tracks.id, trackId));
  const shape: TrackShape = {
    terms: new Map(
      existing.map((t) => [key(t.term), { id: t.id, term: t.term, status: t.status }]),
    ),
    openFixItems: new Set(openFixItems.map((f) => f.text)),
    arcs: track?.plan.arcs ?? [],
    notes: track?.plan.notes ?? "",
    heldElsewhere: new Map(),
  };
  if (actions.some((a) => a.type === "borrow-term"))
    for (const held of (await heldElsewhere(db, trackId)).toReversed())
      shape.heldElsewhere.set(key(held.term), held);
  const rejected = validateActions(shape, actions).flatMap((r) => {
    const action = actions[r.index];
    return action ? [{ ...r, action }] : [];
  });
  if (rejected.length > 0) {
    // Which kinds of edit, and why by code: the reasons quote term names and fix-list items.
    log.warn(
      {
        trackId,
        source: options.source,
        rejected: rejected.map((r) => ({ type: r.action.type, code: r.code })),
        actions: actions.map((a) => a.type),
        ...content({ reasons: rejected.map((r) => r.reason), batch: actions }),
      },
      "track edits rejected",
    );
  }
  return { actions, shape, existing, rejected };
}

/**
 * Applies the model's structured edits to a track. The whole batch is validated against the track
 * as it would be after each edit; any invalid edit rejects the batch, with reasons the model can act
 * on, and nothing is written. (applyValidActions applies the valid part instead.)
 *
 * `rewritePlan` says whether a set-plan may replace the plan, and an edit-plan-notes rewrite a
 * section of its notes: only from a call that saw all of it, every arc's terms and the notes as
 * written (the close and the final, and an import; design §4.4). From any other call they would
 * drop what it didn't see or wasn't asked to change; they are left out (logged), and the rest of
 * the batch applies. A session's plan places its terms with
 * add-to-arc instead, and its add-plan-notes are added after the notes, for the close to fold in.
 */
export async function applyActions(
  db: Db,
  trackId: string,
  batch: readonly TrackAction[],
  options: { source: string; rewritePlan?: boolean },
): Promise<ApplyResult> {
  const checked = await checkBatch(db, trackId, batch, options);
  if (checked.rejected.length > 0)
    return { ok: false, errors: checked.rejected.map((r) => r.reason) };
  await writeBatch(db, trackId, checked, options.source);
  return { ok: true };
}

/**
 * Applies the edits of a batch that validate, and returns the rest with why each was rejected
 * (design §5): so one bad name doesn't cost the rest of what a call recorded. An edit that needs a
 * rejected one is rejected with it. Options as for applyActions.
 */
export async function applyValidActions(
  db: Db,
  trackId: string,
  batch: readonly TrackAction[],
  options: { source: string; rewritePlan?: boolean },
): Promise<{ rejected: RejectedAction[] }> {
  const checked = await checkBatch(db, trackId, batch, options);
  const out = new Set(checked.rejected.map((r) => r.index));
  const actions = checked.actions.filter((_, index) => !out.has(index));
  if (actions.length > 0) await writeBatch(db, trackId, { ...checked, actions }, options.source);
  return { rejected: checked.rejected };
}

/** Writes a batch that validated, in one transaction. */
async function writeBatch(
  db: Db,
  trackId: string,
  { actions, shape, existing }: CheckedBatch,
  source: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // The plan as it is now, held until the batch's changes to it are written.
    const [locked] = await tx
      .select({ plan: tracks.plan, title: tracks.title })
      .from(tracks)
      .where(eq(tracks.id, trackId))
      .for("update");
    let plan: TrackPlan = locked?.plan ?? { arcs: [], notes: "" };
    let planChanged = false;
    const idOf = new Map(existing.map((t) => [key(t.term), t.id]));
    const statusOf = new Map(existing.map((t) => [key(t.term), t.status]));
    const borrowedFrom = new Map(existing.map((t) => [key(t.term), t.borrowedFrom]));
    const record = async (
      termId: string,
      from: TermStatus | null,
      to: TermStatus,
      evidence: string,
    ) => {
      await tx
        .insert(termEvents)
        .values({ termId, fromStatus: from, toStatus: to, evidence, source });
    };
    /** Adds a term to the list, with its first change recorded. */
    const addTerm = async (term: string, status: TermStatus, evidence: string) => {
      const [row] = await tx
        .insert(terms)
        .values({ trackId, term: term.trim(), status })
        .returning();
      if (!row) throw new Error("term insert returned nothing");
      idOf.set(key(row.term), row.id);
      statusOf.set(key(row.term), status);
      await record(row.id, null, status, evidence);
      return row.id;
    };

    for (const action of actions) {
      switch (action.type) {
        case "add-planned-term": {
          // A term already in the list keeps its status and gains what it rests on (#19).
          const termId =
            idOf.get(key(action.term)) ?? (await addTerm(action.term, "planned", "In the plan."));
          const restsOnIds = new Set(
            action.restsOn
              .map((r) => idOf.get(key(r)))
              .filter((id): id is string => id !== undefined && id !== termId),
          );
          if (restsOnIds.size > 0) {
            await tx
              .insert(termDependencies)
              .values([...restsOnIds].map((restsOnTermId) => ({ termId, restsOnTermId })))
              .onConflictDoNothing();
          }
          break;
        }
        case "set-term-status": {
          const termId = idOf.get(key(action.term));
          const evidence = action.evidence.trim();
          if (!termId) {
            await addTerm(action.term, action.status, evidence);
            break;
          }
          // A status recorded here makes a borrowed term this track's own (#54).
          await tx
            .update(terms)
            .set({ status: action.status, borrowedFrom: null })
            .where(eq(terms.id, termId));
          await record(termId, statusOf.get(key(action.term)) ?? null, action.status, evidence);
          statusOf.set(key(action.term), action.status);
          const source = borrowedFrom.get(key(action.term));
          borrowedFrom.set(key(action.term), null);
          // It didn't hold here: demoted here only, and the track it came from hears why, in its
          // term's history (method.md, "Borrowed terms"); its status there was earned there.
          if (source && action.status === "taught") {
            const [held] = await tx
              .select({ status: terms.status })
              .from(terms)
              .where(eq(terms.id, source));
            if (held)
              await tx.insert(termEvents).values({
                termId: source,
                fromStatus: held.status,
                toStatus: held.status,
                evidence: `Didn't hold in "${locked?.title ?? "another track"}", which borrowed it: ${evidence}`,
                source: "another track",
              });
          }
          break;
        }
        case "borrow-term": {
          const held = shape.heldElsewhere.get(key(action.from));
          if (!held) break;
          const evidence = `Held in "${held.track}"${key(held.term) === key(action.term) ? "" : ` as "${held.term}"`}.`;
          const termId = idOf.get(key(action.term));
          if (!termId) {
            const [row] = await tx
              .insert(terms)
              .values({
                trackId,
                term: action.term.trim(),
                status: "confirmed",
                borrowedFrom: held.id,
              })
              .returning();
            if (!row) throw new Error("term insert returned nothing");
            idOf.set(key(row.term), row.id);
            statusOf.set(key(row.term), "confirmed");
            borrowedFrom.set(key(row.term), held.id);
            await record(row.id, null, "confirmed", evidence);
            break;
          }
          if (statusOf.get(key(action.term)) !== "planned") {
            log.info({ trackId, source }, "borrow-term skipped: the term has its own status here");
            break;
          }
          await tx
            .update(terms)
            .set({ status: "confirmed", borrowedFrom: held.id })
            .where(eq(terms.id, termId));
          await record(termId, "planned", "confirmed", evidence);
          statusOf.set(key(action.term), "confirmed");
          borrowedFrom.set(key(action.term), held.id);
          break;
        }
        case "add-fix-item":
          await tx.insert(fixListItems).values({ trackId, text: action.text });
          break;
        case "close-fix-item":
          await tx
            .update(fixListItems)
            .set({ status: "closed", closedAt: sql`now()` })
            .where(
              and(
                eq(fixListItems.trackId, trackId),
                eq(fixListItems.text, action.text),
                eq(fixListItems.status, "open"),
              ),
            );
          break;
        case "set-language":
          await tx
            .update(tracks)
            .set({ language: action.language.trim() })
            .where(eq(tracks.id, trackId));
          break;
        case "add-to-arc": {
          // In the term list's spelling, as the whole batch leaves it.
          const placed = addToArc(
            plan.arcs,
            action,
            (term) => shape.terms.get(key(term))?.term ?? term.trim(),
          );
          if (placed.skipped.length > 0)
            log.info(
              { trackId, source, skipped: placed.skipped.length },
              "add-to-arc skipped terms already in an arc",
            );
          plan = { ...plan, arcs: placed.arcs };
          planChanged = true;
          break;
        }
        case "set-plan":
          plan = { arcs: action.arcs, notes: action.notes ?? plan.notes };
          planChanged = true;
          break;
        case "edit-plan-notes": {
          const edited = editNotesSection(plan.notes, action);
          // Validated against the notes as they were read; changed since, the edit is left out.
          if ("code" in edited) {
            log.warn({ trackId, source, code: edited.code }, "plan notes changed; edit left out");
            break;
          }
          plan = { ...plan, notes: edited.notes };
          planChanged = true;
          break;
        }
        case "add-plan-notes":
          plan = { ...plan, notes: addedNotes(plan.notes, action.notes) };
          planChanged = true;
          break;
      }
    }
    if (planChanged) await tx.update(tracks).set({ plan }).where(eq(tracks.id, trackId));
  });
}

const NOTED_WHILE_PLANNING = "### Noted while planning";

/**
 * Notes from a call that didn't see the notes as written: added after them, under a heading (or
 * under the heading already last, from an earlier plan the close hasn't folded in yet).
 */
function addedNotes(notes: string, added: string): string {
  if (!added.trim()) return notes;
  if (!notes.trim()) return added.trim();
  const lastHeading = notes
    .match(/^#{1,6} .*$/gm)
    ?.at(-1)
    ?.trim();
  if (lastHeading === NOTED_WHILE_PLANNING) return `${notes.trimEnd()}\n\n${added.trim()}`;
  return `${notes.trimEnd()}\n\n${NOTED_WHILE_PLANNING}\n\n${added.trim()}`;
}

export interface TrackContext
  extends
    Required<Pick<PromptContext, "track" | "terms" | "plan" | "fixList">>,
    Pick<PromptContext, "termsNotListed" | "brought" | "heldElsewhere"> {
  /** In a session: what changed since it began (the term list and fix-list are as it began). */
  changes?: NonNullable<PromptContext["changes"]>;
  /** What the learner wrote they want to learn, as typed (the session's opening turn). */
  goal: string;
  /**
   * Every term with its status now: what the server validates the tutor's writing against. A
   * borrowed term is usable as held.
   */
  current: TrackTerm[];
  /** Terms borrowed from the learner's other tracks, as they are now (design §5). */
  borrowed: NonNullable<PromptContext["borrowed"]>;
}

/**
 * The track as the prompt sees it (method.md, "What the app gives you"). For a session's calls
 * (`sessionId`), the term list and fix-list are as the session began and the changes since come
 * apart, so the prompt's track part stays byte-identical all session; and the term list and the
 * plan's arcs carry what matters now, not the whole track (selectTrackView; design §4.4). Without
 * a session, the whole track as it is now.
 */
export async function loadTrackContext(
  db: Db,
  trackId: string,
  options: { sessionId?: string; phase?: Phase } = {},
): Promise<TrackContext> {
  const [track] = await db.select().from(tracks).where(eq(tracks.id, trackId));
  if (!track) throw new Error(`track ${trackId} not found`);
  // Compared in the database, at its precision: a JavaScript Date keeps only milliseconds.
  const began = options.sessionId
    ? sql`(select ${learningSessions.createdAt} from ${learningSessions} where ${learningSessions.id} = ${options.sessionId})`
    : sql`'infinity'::timestamptz`;
  const rows = await db
    .select({
      id: terms.id,
      term: terms.term,
      status: terms.status,
      borrowedFrom: terms.borrowedFrom,
      existed: sql<boolean>`${terms.createdAt} < ${began}`,
    })
    .from(terms)
    .where(eq(terms.trackId, trackId))
    .orderBy(terms.createdAt, terms.id);
  // Borrowed terms are listed apart, as they are now: the plan borrows them, once a session, as the
  // plan itself changes (design §4.4).
  const sourceIds = rows.flatMap((r) => (r.borrowedFrom ? [r.borrowedFrom] : []));
  const sources = new Map(
    sourceIds.length
      ? (
          await db
            .select({ id: terms.id, term: terms.term, track: tracks.title })
            .from(terms)
            .innerJoin(tracks, eq(tracks.id, terms.trackId))
            .where(inArray(terms.id, sourceIds))
        ).map((s) => [s.id, s])
      : [],
  );
  const borrowed = rows.flatMap((r) => {
    const source = r.borrowedFrom ? sources.get(r.borrowedFrom) : undefined;
    if (!source) return [];
    return [
      {
        term: r.term,
        fromTrack: source.track,
        ...(key(source.term) === key(r.term) ? {} : { as: source.term }),
      },
    ];
  });
  const isBorrowed = new Set(borrowed.map((b) => key(b.term)));
  // Each term's status as the session began: the last change recorded before then.
  const then = new Map(
    options.sessionId && rows.length
      ? (
          await db
            .selectDistinctOn([termEvents.termId], {
              termId: termEvents.termId,
              status: termEvents.toStatus,
            })
            .from(termEvents)
            .where(
              and(
                inArray(
                  termEvents.termId,
                  rows.map((r) => r.id),
                ),
                sql`${termEvents.createdAt} < ${began}`,
              ),
            )
            .orderBy(termEvents.termId, desc(termEvents.createdAt), desc(termEvents.id))
        ).map((e) => [e.termId, e.status])
      : [],
  );
  const deps = rows.length
    ? await db
        .select()
        .from(termDependencies)
        .where(
          inArray(
            termDependencies.termId,
            rows.map((r) => r.id),
          ),
        )
    : [];
  const nameOf = new Map(rows.map((r) => [r.id, r.term]));
  // In the term list's order, so the prompt renders the same way on every load (design §4.4).
  const position = new Map(rows.map((r, i) => [r.id, i]));
  const restsOn = new Map<string, string[]>();
  for (const d of deps.toSorted(
    (a, b) =>
      (position.get(a.restsOnTermId) ?? rows.length) -
      (position.get(b.restsOnTermId) ?? rows.length),
  )) {
    restsOn.set(d.termId, [...(restsOn.get(d.termId) ?? []), nameOf.get(d.restsOnTermId) ?? ""]);
  }
  const fixList = await db
    .select({
      text: fixListItems.text,
      status: fixListItems.status,
      existed: sql<boolean>`${fixListItems.createdAt} < ${began}`,
      closedBefore: sql<boolean>`coalesce(${fixListItems.closedAt} < ${began}, false)`,
    })
    .from(fixListItems)
    .where(eq(fixListItems.trackId, trackId))
    .orderBy(fixListItems.createdAt, sql`${fixListItems.id}`);

  const listed: TermRow[] = [];
  const changes = { terms: [] as TermRow[], fixList: [] as FixItem[] };
  for (const r of rows) {
    if (isBorrowed.has(key(r.term))) continue;
    const row = { term: r.term, status: r.status, restsOn: restsOn.get(r.id) ?? [] };
    if (!r.existed) {
      changes.terms.push(row);
      continue;
    }
    // A term with no change recorded before the session (none is written without one) keeps its own.
    const status = then.get(r.id) ?? r.status;
    listed.push({ ...row, status });
    if (status !== r.status) changes.terms.push(row);
  }
  const fixItems: FixItem[] = [];
  for (const f of fixList) {
    const item = { text: f.text, status: f.status };
    if (!f.existed) {
      changes.fixList.push(item);
      continue;
    }
    const status = f.closedBefore ? "closed" : "open";
    fixItems.push({ ...item, status });
    if (status !== f.status) changes.fixList.push(item);
  }

  const current = rows.map((r): TrackTerm => ({
    term: r.term,
    status: isBorrowed.has(key(r.term)) ? "borrowed" : r.status,
  }));
  const files = await db
    .select({ name: trackFiles.name })
    .from(trackFiles)
    .where(eq(trackFiles.trackId, trackId))
    .orderBy(trackFiles.createdAt, trackFiles.id);
  const whole = {
    track: { title: track.title, language: track.language },
    // What the learner brought, summarized (design §4.5); a call that reads the files leaves it out.
    ...(files.length ? { brought: { files: files.map((f) => f.name), summary: track.brief } } : {}),
    goal: track.goal,
    terms: listed,
    plan: track.plan,
    fixList: fixItems,
    current,
    borrowed,
  };
  if (!options.sessionId) return whole;

  const { phase } = options;
  const view = selectTrackView({
    terms: listed,
    arcs: track.plan.arcs,
    touched: await touchedBefore(db, trackId, began),
    wholePlan: phase !== undefined && WHOLE_PLAN_PHASES.includes(phase),
  });
  // Until the first close writes "where you left off", the notes as written (session-tasks.ts
  // writes one first when they are long).
  const notes =
    (phase !== undefined && NOTES_PHASES.includes(phase)) || track.leftOff === null
      ? { notes: track.plan.notes }
      : { leftOff: track.leftOff };
  // The plan may borrow what the learner holds in their other tracks instead of teaching it (#54).
  const elsewhere = phase === "plan" ? await heldElsewhere(db, trackId) : [];
  const byTrack = Map.groupBy(elsewhere.slice(0, HELD_ELSEWHERE_LIMIT), (h) => h.track);
  return {
    ...whole,
    terms: view.terms,
    termsNotListed: view.termsNotListed,
    plan: { arcs: view.arcs, ...notes },
    changes,
    ...(byTrack.size
      ? {
          heldElsewhere: [...byTrack].map(([track, held]) => ({
            track,
            terms: held.map((h) => h.term),
          })),
        }
      : {}),
  };
}

/** A term the learner holds in another of their tracks (design §5). */
export interface HeldTerm {
  id: string;
  term: string;
  track: string;
}

/**
 * What the learner holds in their tracks other than this one: terms confirmed or assumed there on
 * that track's own evidence (a term borrowed there is listed by the track it came from). The most
 * recently active track first, each track's terms in its term list's order.
 */
export async function heldElsewhere(db: Db, trackId: string): Promise<HeldTerm[]> {
  const owner = db.select({ userId: tracks.userId }).from(tracks).where(eq(tracks.id, trackId));
  return db
    .select({ id: terms.id, term: terms.term, track: tracks.title })
    .from(terms)
    .innerJoin(tracks, eq(tracks.id, terms.trackId))
    .where(
      and(
        sql`${tracks.userId} = (${owner})`,
        sql`${tracks.id} <> ${trackId}`,
        inArray(terms.status, ["confirmed", "assumed"]),
        isNull(terms.borrowedFrom),
      ),
    )
    .orderBy(desc(tracks.updatedAt), tracks.id, terms.createdAt, terms.id);
}

/**
 * How many held terms of other tracks the plan's prompt lists at most (about 2,000 tokens), the
 * most recently active tracks first: what it may borrow (#54). The server checks a borrow against
 * all of them.
 */
export const HELD_ELSEWHERE_LIMIT = 300;

/** How many earlier sessions count as recent: the terms they touched are listed (design §4.4). */
export const RECENT_SESSIONS = 3;

/**
 * The terms touched recently: any change recorded in the RECENT_SESSIONS sessions of the track
 * before this one, from the first of them up to this one's start. Changes from before the track's
 * first session (an import) are not recent.
 */
async function touchedBefore(
  db: Db,
  trackId: string,
  began: ReturnType<typeof sql>,
): Promise<string[]> {
  const recent = sql`(select min(created_at) from (select ${learningSessions.createdAt} as created_at from ${learningSessions} where ${learningSessions.trackId} = ${trackId} and ${learningSessions.createdAt} < ${began} order by ${learningSessions.createdAt} desc limit ${RECENT_SESSIONS}) as recent)`;
  const touched = await db
    .selectDistinct({ term: terms.term })
    .from(termEvents)
    .innerJoin(terms, eq(terms.id, termEvents.termId))
    .where(
      and(
        eq(terms.trackId, trackId),
        sql`${termEvents.createdAt} >= ${recent}`,
        sql`${termEvents.createdAt} < ${began}`,
      ),
    );
  return touched.map((t) => t.term);
}
