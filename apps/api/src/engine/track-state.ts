import type { PromptContext, TrackAction } from "@grounded/core";
import {
  and,
  eq,
  fixListItems,
  inArray,
  sql,
  termDependencies,
  termEvents,
  terms,
  tracks,
  type Db,
  type TermStatus,
} from "@grounded/db";

export type ApplyResult = { ok: true } | { ok: false; errors: string[] };

interface KnownTerm {
  id: string | null;
  term: string;
  status: TermStatus;
}

const key = (term: string) => term.trim().toLowerCase();

/**
 * Applies the model's structured edits to a track. The whole batch is validated against the track
 * as it would be after each edit; any invalid edit rejects the batch, with reasons the model can act
 * on, and nothing is written.
 */
export async function applyActions(
  db: Db,
  trackId: string,
  actions: readonly TrackAction[],
  options: { source: string },
): Promise<ApplyResult> {
  const existing = await db.select().from(terms).where(eq(terms.trackId, trackId));
  const known = new Map<string, KnownTerm>(
    existing.map((t) => [key(t.term), { id: t.id, term: t.term, status: t.status }]),
  );
  const openFixItems = new Set(
    (
      await db
        .select()
        .from(fixListItems)
        .where(and(eq(fixListItems.trackId, trackId), eq(fixListItems.status, "open")))
    ).map((f) => f.text),
  );

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
  if (errors.length > 0) return { ok: false, errors };

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
        case "set-plan":
          await tx
            .update(tracks)
            .set({ plan: { arcs: action.arcs, notes: action.notes } })
            .where(eq(tracks.id, trackId));
          break;
      }
    }
  });
  return { ok: true };
}

/** The track as the prompt sees it (method.md, "What the app gives you"). */
export async function loadTrackContext(
  db: Db,
  trackId: string,
): Promise<Required<Pick<PromptContext, "track" | "terms" | "plan" | "fixList">>> {
  const [track] = await db.select().from(tracks).where(eq(tracks.id, trackId));
  if (!track) throw new Error(`track ${trackId} not found`);
  const rows = await db
    .select()
    .from(terms)
    .where(eq(terms.trackId, trackId))
    .orderBy(terms.createdAt, terms.id);
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
  const fixList = await db
    .select()
    .from(fixListItems)
    .where(eq(fixListItems.trackId, trackId))
    .orderBy(fixListItems.createdAt, sql`${fixListItems.id}`);

  return {
    track: { title: track.title, language: track.language },
    terms: rows.map((r) => ({
      term: r.term,
      status: r.status,
      restsOn: deps.filter((d) => d.termId === r.id).map((d) => nameOf.get(d.restsOnTermId) ?? ""),
    })),
    plan: track.plan,
    fixList: fixList.map((f) => ({ text: f.text, status: f.status })),
  };
}
