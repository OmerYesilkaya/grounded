import type { Db } from "@grounded/db";
import type { Hono } from "hono";
import { z } from "zod";
import { callDetail } from "../admin/calls.js";
import { filterOptions, parseFilters } from "../admin/filters.js";
import { requireOperator } from "../admin/guard.js";
import { learnerEmail, listLearners } from "../admin/learners.js";
import { overview } from "../admin/overview.js";
import { replay } from "../admin/replay.js";
import { HAS, listSessions } from "../admin/sessions.js";
import type { SignedInUser } from "../auth.js";
import { notFound } from "../refusals.js";

interface Env {
  Variables: { user: SignedInUser };
}

const learnerNumber = z.coerce.number().int().positive();

const sessionQuery = z.object({
  learner: learnerNumber.optional(),
  track: z.uuid().optional(),
  issue: z.string().min(1).optional(),
  has: z.enum(Object.keys(HAS) as [keyof typeof HAS, ...(keyof typeof HAS)[]]).optional(),
  phase: z.string().min(1).optional(),
  before: z.iso.datetime({ offset: true }).optional(),
});

/**
 * The admin panel's routes (design §10.1): read-only, for operators only; anyone else is answered
 * 404 by the guard.
 */
export function registerAdminRoutes(app: Hono<Env>, deps: { db: Db }) {
  const { db } = deps;
  app.use("/api/admin/*", requireOperator(db));

  /** Who the operator is: the panel's check that it may open. */
  app.get("/api/admin/me", (c) => c.json({ email: c.get("user").email }));

  app.get("/api/admin/filters", async (c) => c.json(await filterOptions(db)));

  app.get("/api/admin/overview", async (c) =>
    c.json(await overview(db, parseFilters(c.req.query()))),
  );

  app.get("/api/admin/sessions", async (c) => {
    const parsed = sessionQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json(notFound, 404);
    const q = parsed.data;
    return c.json(
      await listSessions(db, parseFilters(c.req.query()), {
        learner: q.learner ?? null,
        trackId: q.track ?? null,
        issue: q.issue ?? null,
        has: q.has ?? null,
        phase: q.phase ?? null,
        before: q.before ? new Date(q.before) : null,
      }),
    );
  });

  app.get("/api/admin/sessions/:id", async (c) => {
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success) return c.json(notFound, 404);
    const found = await replay(db, id);
    return found ? c.json(found) : c.json(notFound, 404);
  });

  app.get("/api/admin/calls/:id", async (c) => {
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success) return c.json(notFound, 404);
    const found = await callDetail(db, id);
    return found ? c.json(found) : c.json(notFound, 404);
  });

  app.get("/api/admin/learners", async (c) => c.json(await listLearners(db)));

  app.get("/api/admin/learners/:number/email", async (c) => {
    const parsed = learnerNumber.safeParse(c.req.param("number"));
    if (!parsed.success) return c.json(notFound, 404);
    const email = await learnerEmail(db, parsed.data);
    return email ? c.json({ email }) : c.json(notFound, 404);
  });
}
