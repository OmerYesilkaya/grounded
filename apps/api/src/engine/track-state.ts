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
  learningSessions,
  sql,
  termDependencies,
  termEvents,
  terms,
  tracks,
  type Db,
  type TermStatus,
} from "@grounded/db";
import { log } from "../log.js";

export type ApplyResult = { ok: true } | { ok: false; errors: string[] };

export interface KnownTerm {
  id: string | null;
  term: string;
  status: TermStatus;
}

const key = (term: string) => term.trim().toLowerCase();

/** What the track looks like to the validator: its terms by lowercased name, and its open fix-list items. */
export interface TrackShape {
  terms: Map<string, KnownTerm>;
  openFixItems: Set<string>;
}

/** An empty track: the shape a batch is validated against before the track exists (an import). */
export function emptyTrackShape(): TrackShape {
  return { terms: new Map(), openFixItems: new Set() };
}

/**
 * Checks a batch against the track as it would be after each edit, without writing anything. Returns
 * the reasons the model can act on; empty when the whole batch is valid. The shape is updated in place.
 */
export function validateActions(shape: TrackShape, actions: readonly TrackAction[]): string[] {
  const { terms: known, openFixItems } = shape;
  const errors: string[] = [];
  for (const action of actions) {
    switch (action.type) {
      case "set-term-status": {
        const term = known.get(key(action.term));
        if (!term && action.status !== "assumed") {
          errors.push(
            `"${action.term}" isn't in the term list; add it as a planned term first (or as assumed, if the learner already knew it).`,
          );
        } else if (!action.evidence.trim()) {
          errors.push(
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
        if (known.has(key(action.term))) {
          errors.push(
            `"${known.get(key(action.term))?.term ?? action.term}" is already in the term list.`,
          );
          break;
        }
        const missing = action.restsOn.find((r) => !known.has(key(r)));
        if (missing) {
          errors.push(`"${action.term}" rests on "${missing}", which isn't in the term list.`);
          break;
        }
        known.set(key(action.term), { id: null, term: action.term.trim(), status: "planned" });
        break;
      }
      case "close-fix-item":
        if (!openFixItems.has(action.text))
          errors.push(`There is no open fix-list item "${action.text}".`);
        else openFixItems.delete(action.text);
        break;
      case "add-fix-item":
        openFixItems.add(action.text);
        break;
      case "set-language":
        if (!action.language.trim()) errors.push("set-language needs the name of a language.");
        break;
      case "set-plan":
        break;
    }
  }
  return errors;
}

/**
 * Applies the model's structured edits to a track. The whole batch is validated against the track
 * as it would be after each edit; any invalid edit rejects the batch, with reasons the model can act
 * on, and nothing is written.
 *
 * `plan` says what the call saw of the plan (design §4.4). "whole" (the default): every arc with
 * its terms and the notes as written, so a set-plan replaces the plan. "arcs": every arc, but only
 * "where you left off" in place of the notes, so a set-plan replaces the arcs and its notes are
 * added to the notes, for the close to fold in. "none": the arcs other than the current one only as
 * tallies, so a set-plan would drop what it didn't see; it is left out, and the rest of the batch
 * applies.
 */
export async function applyActions(
  db: Db,
  trackId: string,
  batch: readonly TrackAction[],
  options: { source: string; plan?: "whole" | "arcs" | "none" },
): Promise<ApplyResult> {
  const actions =
    options.plan === "none" ? batch.filter((action) => action.type !== "set-plan") : batch;
  const existing = await db.select().from(terms).where(eq(terms.trackId, trackId));
  const openFixItems = await db
    .select()
    .from(fixListItems)
    .where(and(eq(fixListItems.trackId, trackId), eq(fixListItems.status, "open")));
  const errors = validateActions(
    {
      terms: new Map(
        existing.map((t) => [key(t.term), { id: t.id, term: t.term, status: t.status }]),
      ),
      openFixItems: new Set(openFixItems.map((f) => f.text)),
    },
    actions,
  );
  if (errors.length > 0) {
    // How many and which kinds of edit: the reasons quote term names and fix-list items.
    log.warn(
      {
        trackId,
        source: options.source,
        rejected: errors.length,
        actions: actions.map((a) => a.type),
      },
      "track edits rejected",
    );
    return { ok: false, errors };
  }

  await db.transaction(async (tx) => {
    const idOf = new Map(existing.map((t) => [key(t.term), t.id]));
    const statusOf = new Map(existing.map((t) => [key(t.term), t.status]));
    const record = async (
      termId: string,
      from: TermStatus | null,
      to: TermStatus,
      evidence: string,
    ) => {
      await tx
        .insert(termEvents)
        .values({ termId, fromStatus: from, toStatus: to, evidence, source: options.source });
    };

    for (const action of actions) {
      switch (action.type) {
        case "add-planned-term": {
          const [row] = await tx
            .insert(terms)
            .values({ trackId, term: action.term.trim(), status: "planned" })
            .returning();
          if (!row) throw new Error("term insert returned nothing");
          idOf.set(key(row.term), row.id);
          statusOf.set(key(row.term), "planned");
          const restsOnIds = action.restsOn
            .map((r) => idOf.get(key(r)))
            .filter((id): id is string => Boolean(id));
          if (restsOnIds.length > 0) {
            await tx
              .insert(termDependencies)
              .values(restsOnIds.map((restsOnTermId) => ({ termId: row.id, restsOnTermId })));
          }
          await record(row.id, null, "planned", "In the plan.");
          break;
        }
        case "set-term-status": {
          let termId = idOf.get(key(action.term));
          const from = statusOf.get(key(action.term)) ?? null;
          if (termId) {
            await tx.update(terms).set({ status: action.status }).where(eq(terms.id, termId));
          } else {
            const [row] = await tx
              .insert(terms)
              .values({ trackId, term: action.term.trim(), status: action.status })
              .returning();
            if (!row) throw new Error("term insert returned nothing");
            termId = row.id;
            idOf.set(key(row.term), row.id);
          }
          statusOf.set(key(action.term), action.status);
          await record(termId, from, action.status, action.evidence.trim());
          break;
        }
        case "add-fix-item":
          await tx.insert(fixListItems).values({ trackId, text: action.text });
          break;
        case "close-fix-item":
          await tx
            .update(fixListItems)
            .set({ status: "closed", closedAt: new Date() })
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
        case "set-plan": {
          let notes = action.notes;
          if (options.plan === "arcs") {
            const [track] = await tx
              .select({ plan: tracks.plan })
              .from(tracks)
              .where(eq(tracks.id, trackId));
            notes = addedNotes(track?.plan.notes ?? "", action.notes);
          }
          await tx
            .update(tracks)
            .set({ plan: { arcs: action.arcs, notes } })
            .where(eq(tracks.id, trackId));
          break;
        }
      }
    }
  });
  return { ok: true };
}

/** Notes from a call that didn't see the notes as written: added after them, under a heading. */
function addedNotes(notes: string, added: string): string {
  if (!added.trim()) return notes;
  if (!notes.trim()) return added.trim();
  return `${notes.trimEnd()}\n\n### Noted while planning\n\n${added.trim()}`;
}

export interface TrackContext
  extends
    Required<Pick<PromptContext, "track" | "terms" | "plan" | "fixList">>,
    Pick<PromptContext, "termsNotListed"> {
  /** In a session: what changed since it began (the term list and fix-list are as it began). */
  changes?: NonNullable<PromptContext["changes"]>;
  /** What the learner wrote they want to learn, as typed (the session's opening turn). */
  goal: string;
  /** Every term with its status now: what the server validates the tutor's writing against. */
  current: { term: string; status: TermStatus }[];
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
      existed: sql<boolean>`${terms.createdAt} < ${began}`,
    })
    .from(terms)
    .where(eq(terms.trackId, trackId))
    .orderBy(terms.createdAt, terms.id);
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

  const current = rows.map((r) => ({ term: r.term, status: r.status }));
  const whole = {
    track: { title: track.title, language: track.language },
    goal: track.goal,
    terms: listed,
    plan: track.plan,
    fixList: fixItems,
    current,
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
  return {
    ...whole,
    terms: view.terms,
    termsNotListed: view.termsNotListed,
    plan: { arcs: view.arcs, ...notes },
    changes,
  };
}

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
