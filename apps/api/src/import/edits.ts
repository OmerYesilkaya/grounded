import type { ImportReading, TrackAction } from "@grounded/core";
import type { LedgerTerm } from "./ledger.js";

/** The imported track's teaching language: the earlier setup's state is written in English. */
export const IMPORT_LANGUAGE = "English";

export interface ImportEdits {
  actions: TrackAction[];
  /** What the reading named that isn't a term, and the cycles broken, one line each. */
  unplaced: string[];
}

/**
 * Turns the parsed terms and the model's reading (by term number, 1-based) into the track edits:
 * the language, every term as a planned term in dependency order (the only edit that records what a
 * term rests on), the statuses with their evidence, the plan, then the fix-list.
 */
export function buildEdits(terms: readonly LedgerTerm[], reading: ImportReading): ImportEdits {
  const unplaced: string[] = [];
  const name = (id: number) => terms[id - 1]?.term ?? "";
  const known = (id: number) => Number.isInteger(id) && id >= 1 && id <= terms.length;

  const restsOn = new Map<number, Set<number>>();
  for (const dependency of reading.dependencies) {
    if (!known(dependency.term)) {
      unplaced.push(
        `A dependency named term ${String(dependency.term)}, which isn't in the list; left out.`,
      );
      continue;
    }
    const edges = restsOn.get(dependency.term) ?? new Set<number>();
    for (const id of dependency.restsOn) {
      if (!known(id)) {
        unplaced.push(
          `"${name(dependency.term)}" was said to rest on term ${String(id)}, which isn't in the list; left out.`,
        );
      } else if (id === dependency.term) {
        unplaced.push(`"${name(id)}" was said to rest on itself; left out.`);
      } else {
        edges.add(id);
      }
    }
    restsOn.set(dependency.term, edges);
  }

  const order = dependencyOrder(terms.length, restsOn, (from, to) =>
    unplaced.push(
      `"${name(from)}" was said to rest on "${name(to)}", which already rests on it (directly or through other terms): a cycle; that edge was left out.`,
    ),
  );

  const actions: TrackAction[] = [{ type: "set-language", language: IMPORT_LANGUAGE }];
  for (const id of order) {
    const edges = [...(restsOn.get(id) ?? [])].sort((a, b) => a - b);
    actions.push({ type: "add-planned-term", term: name(id), restsOn: edges.map(name) });
  }
  for (const term of terms) {
    if (term.status === "planned") continue;
    actions.push({
      type: "set-term-status",
      term: term.term,
      status: term.status,
      evidence: term.evidence || `Listed as ${term.status} in the ledger.`,
    });
  }

  const arcs = reading.arcs.map((arc, index) => {
    const title = arc.title.trim() || `Arc ${String(index + 1)}`;
    const ids: number[] = [];
    for (const id of arc.terms) {
      if (!known(id)) {
        unplaced.push(
          `Arc "${title}" listed term ${String(id)}, which isn't in the list; left out.`,
        );
      } else if (!ids.includes(id)) {
        ids.push(id);
      }
    }
    return { title, terms: ids.map(name) };
  });
  actions.push({ type: "set-plan", arcs, notes: reading.planNotes.trim() });

  const seen = new Set<string>();
  for (const item of reading.fixItems) {
    const text = item.trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    actions.push({ type: "add-fix-item", text });
  }

  unplaced.push(...reading.unplaced.map((u) => u.trim()).filter(Boolean));
  return { actions, unplaced };
}

/**
 * Every id from 1 to `count`, each after everything it rests on, otherwise in list order. An edge that
 * would close a cycle is removed from `restsOn` and reported.
 */
function dependencyOrder(
  count: number,
  restsOn: Map<number, Set<number>>,
  onCycle: (from: number, to: number) => void,
): number[] {
  const order: number[] = [];
  const state = new Map<number, "visiting" | "done">();
  const visit = (id: number) => {
    state.set(id, "visiting");
    const edges = restsOn.get(id);
    for (const next of [...(edges ?? [])].sort((a, b) => a - b)) {
      const seen = state.get(next);
      if (seen === "visiting") {
        edges?.delete(next);
        onCycle(id, next);
      } else if (seen === undefined) {
        visit(next);
      }
    }
    state.set(id, "done");
    order.push(id);
  };
  for (let id = 1; id <= count; id++) if (!state.has(id)) visit(id);
  return order;
}
