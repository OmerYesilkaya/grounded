import { and, asc, eq, inArray, termEvents, tracks, type Db, type TermStatus } from "@grounded/db";
import type { Hono } from "hono";
import { z } from "zod";
import type { SignedInUser } from "../auth.js";
import { addLogContext } from "../log.js";
import { notFound } from "../refusals.js";
import { loadTrackTerms } from "../term-map.js";

interface Env {
  Variables: { user: SignedInUser };
}

/** A term as the method keeps it, with every change it has been through (design §10). */
export interface RawTerm {
  term: string;
  status: TermStatus;
  /** The track a borrowed term is held in. */
  borrowedFrom: string | null;
  /** What it rests on, by name, in the term list's order. */
  restsOn: string[];
  /** Oldest first. */
  events: {
    from: TermStatus | null;
    to: TermStatus;
    evidence: string;
    source: string;
    at: string;
  }[];
}

/**
 * Development only, for whoever is building the app (design §10): a track's terms as stored, with
 * the method's statuses (planned, taught, confirmed, assumed) the learner's pages translate or
 * hide, and each term's history. Registered only when `devTools` is on, so a learner in production
 * never reads a planned term before it is taught.
 */
export function registerDevRoutes(app: Hono<Env>, deps: { db: Db }) {
  const { db } = deps;

  app.get("/api/dev/tracks/:id/terms", async (c) => {
    const trackId = c.req.param("id");
    if (!z.uuid().safeParse(trackId).success) return c.json(notFound, 404);
    addLogContext({ trackId });
    const [track] = await db
      .select({ id: tracks.id })
      .from(tracks)
      .where(and(eq(tracks.id, trackId), eq(tracks.userId, c.get("user").id)));
    if (!track) return c.json(notFound, 404);

    const all = await loadTrackTerms(db, trackId);
    const ids = all.terms.map((t) => t.id);
    const events = ids.length
      ? await db
          .select()
          .from(termEvents)
          .where(inArray(termEvents.termId, ids))
          .orderBy(asc(termEvents.createdAt), asc(termEvents.id))
      : [];
    const nameOf = new Map(all.terms.map((t) => [t.id, t.term]));
    const terms: RawTerm[] = all.terms.map((t) => ({
      term: t.term,
      status: t.status,
      borrowedFrom: t.from,
      restsOn: (all.restsOn.get(t.id) ?? []).map((id) => nameOf.get(id) ?? ""),
      events: events
        .filter((e) => e.termId === t.id)
        .map((e) => ({
          from: e.fromStatus,
          to: e.toStatus,
          evidence: e.evidence,
          source: e.source,
          at: e.createdAt.toISOString(),
        })),
    }));
    return c.json({ terms });
  });
}
