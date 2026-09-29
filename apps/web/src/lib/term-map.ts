import { queryOptions } from "@tanstack/react-query";
import { api } from "./api";

/** Where the learner stands with an idea, in their words (api: term-map.ts). */
export type Standing = "owned" | "settling" | "coming";

export interface MapNode {
  term: string;
  standing: Standing;
  /** One of the ideas the picture is drawn around; the others are what they rest on. */
  focus: boolean;
  /** The track a borrowed idea is held in. */
  from?: string;
}

/** A picture of what rests on what, drawn by the app from the term dependencies (design §3.2). */
export interface TermMap {
  nodes: MapNode[];
  edges: { term: string; restsOn: string }[];
}

export interface SessionPictures {
  plan: { messageId: string; map: TermMap } | null;
  built: TermMap | null;
}

/** A session's pictures; asked again whenever the session's phase or plan moves on. */
export const picturesQuery = (sessionId: string, moment: string) =>
  queryOptions({
    queryKey: ["pictures", sessionId, moment],
    queryFn: () => api<SessionPictures>(`/api/sessions/${sessionId}/pictures`),
    staleTime: Infinity,
  });

/** How many times the layers are reordered, down and up, to untangle the lines. */
const SWEEPS = 4;

/**
 * The picture's rows, top first: every idea sits above what it rests on, so the ground is the
 * bottom row and each idea is one row above the highest thing under it. Within a row, ideas are
 * ordered to keep the lines between rows short and uncrossed (the barycentre heuristic), starting
 * from the term list's order, so the same map always draws the same way. Pure.
 */
export function layers(map: TermMap): string[][] {
  const names = map.nodes.map((n) => n.term);
  const shown = new Set(names);
  const under = new Map<string, string[]>(names.map((n) => [n, []]));
  const over = new Map<string, string[]>(names.map((n) => [n, []]));
  for (const { term, restsOn } of map.edges) {
    if (!shown.has(term) || !shown.has(restsOn) || term === restsOn) continue;
    under.get(term)?.push(restsOn);
    over.get(restsOn)?.push(term);
  }

  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const levelOf = (name: string): number => {
    const known = level.get(name);
    if (known !== undefined) return known;
    // A cycle can't be drawn bottom-up; the edge that closes it is drawn level.
    if (visiting.has(name)) return 0;
    visiting.add(name);
    const below = under.get(name) ?? [];
    const value = below.length ? 1 + Math.max(...below.map(levelOf)) : 0;
    visiting.delete(name);
    level.set(name, value);
    return value;
  };
  const height = Math.max(0, ...names.map(levelOf)) + 1;
  const rows: string[][] = Array.from({ length: height }, () => []);
  for (const name of names) rows[height - 1 - levelOf(name)]?.push(name);

  // Each idea's place across its row, from 0 to 1, so rows of different lengths compare.
  const position = new Map<string, number>();
  for (const row of rows) row.forEach((name, i) => position.set(name, (i + 0.5) / row.length));
  const centre = (neighbours: readonly string[], fallback: number) => {
    const at = neighbours.flatMap((n) => {
      const p = position.get(n);
      return p === undefined ? [] : [p];
    });
    return at.length ? at.reduce((a, b) => a + b, 0) / at.length : fallback;
  };
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    const order = sweep % 2 === 0 ? rows.keys() : [...rows.keys()].reverse();
    for (const r of order) {
      const row = rows[r];
      if (!row) continue;
      const weight = new Map(
        row.map((name) => [
          name,
          centre([...(under.get(name) ?? []), ...(over.get(name) ?? [])], position.get(name) ?? 0),
        ]),
      );
      row.sort((a, b) => (weight.get(a) ?? 0) - (weight.get(b) ?? 0));
      row.forEach((name, i) => position.set(name, (i + 0.5) / row.length));
    }
  }
  return rows;
}
