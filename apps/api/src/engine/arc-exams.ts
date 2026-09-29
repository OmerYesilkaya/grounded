import { allowedBlocksLine, arcsClosedBy, type ArcOfPlan, type TermStatus } from "@grounded/core";
import {
  and,
  asc,
  assignments,
  desc,
  eq,
  inArray,
  isNull,
  learningSessions,
  lessons,
  sql,
  termDependencies,
  termEvents,
  terms,
  tracks,
  type Db,
} from "@grounded/db";
import type { AssignmentRow } from "./assignments.js";

/*
 * Arc exams (design §7.4, method.md "The arc exam"): the session that closes an arc sets an exam
 * over the whole arc besides its homework. The plan's arcs record which session closed each
 * (`closedIn`); the exam is an assignment of kind "exam" of that session. It never holds its
 * session, is never folded into homework, and is handed in whole or not at all.
 */

const key = (term: string) => term.trim().toLowerCase();

/**
 * The arcs this session closes, if its homework were set now (arcsClosedBy): the plan's arcs, its
 * terms' statuses now and as the session began, and what its lesson introduces.
 */
export async function arcsClosing(
  db: Db,
  session: { id: string; trackId: string },
): Promise<ArcOfPlan[]> {
  const [track] = await db
    .select({ plan: tracks.plan })
    .from(tracks)
    .where(eq(tracks.id, session.trackId));
  const arcs = track?.plan.arcs ?? [];
  if (arcs.length === 0) return [];
  // Compared in the database, at its precision: a JavaScript Date keeps only milliseconds.
  const began = sql`(select ${learningSessions.createdAt} from ${learningSessions} where ${learningSessions.id} = ${session.id})`;
  const rows = await db
    .select({ id: terms.id, term: terms.term, status: terms.status })
    .from(terms)
    .where(and(eq(terms.trackId, session.trackId), sql`${terms.createdAt} < ${began}`));
  // A term's status as the session began: the last change recorded before then.
  const then = rows.length
    ? await db
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
    : [];
  const thenOf = new Map(then.map((e) => [e.termId, e.status]));
  const before = new Map<string, TermStatus>(
    rows.map((r) => [r.term, thenOf.get(r.id) ?? r.status]),
  );
  const now = new Map<string, TermStatus>(
    (
      await db
        .select({ term: terms.term, status: terms.status })
        .from(terms)
        .where(eq(terms.trackId, session.trackId))
    ).map((r) => [r.term, r.status]),
  );
  const [lesson] = await db
    .select({ outline: lessons.outline })
    .from(lessons)
    .where(eq(lessons.sessionId, session.id));
  const introduced = lesson?.outline?.steps.flatMap((step) => step.introduces) ?? [];
  return arcsClosedBy({ arcs, before, now, introduced });
}

/** Records that the session closed these arcs (by title), once its exam is kept. */
export async function markArcsClosed(
  db: Db,
  session: { id: string; trackId: string },
  closed: readonly ArcOfPlan[],
): Promise<void> {
  const titles = new Set(closed.map((arc) => key(arc.title)));
  await db.transaction(async (tx) => {
    const [track] = await tx
      .select({ plan: tracks.plan })
      .from(tracks)
      .where(eq(tracks.id, session.trackId))
      .for("update");
    if (!track) return;
    const arcs = track.plan.arcs.map((arc) =>
      titles.has(key(arc.title)) && !arc.closedIn ? { ...arc, closedIn: session.id } : arc,
    );
    await tx
      .update(tracks)
      .set({ plan: { ...track.plan, arcs } })
      .where(eq(tracks.id, session.trackId));
  });
}

/** The heading the arcs an exam covers go under in its call. */
export const EXAM_ARCS = "The arc this exam covers";

/**
 * The arcs an exam covers, for its call: each one's terms with their statuses now and what they
 * rest on (the dependency map, for its cross-session questions), and the sessions whose lessons
 * taught them, by number and title.
 */
export async function examArcsRecord(
  db: Db,
  trackId: string,
  arcs: readonly ArcOfPlan[],
): Promise<string> {
  const rows = await db
    .select({ id: terms.id, term: terms.term, status: terms.status })
    .from(terms)
    .where(eq(terms.trackId, trackId));
  const byKey = new Map(rows.map((r) => [key(r.term), r]));
  const nameOf = new Map(rows.map((r) => [r.id, r.term]));
  const edges = rows.length
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
  const sessions = await db
    .select({ id: learningSessions.id, outline: lessons.outline })
    .from(learningSessions)
    .leftJoin(lessons, eq(lessons.sessionId, learningSessions.id))
    .where(eq(learningSessions.trackId, trackId))
    .orderBy(asc(learningSessions.createdAt), asc(learningSessions.id));

  return arcs
    .map((arc) => {
      const inArc = new Set(arc.terms.map(key));
      const termLines = arc.terms.map((name) => {
        const row = byKey.get(key(name));
        const restsOn = row
          ? edges.filter((e) => e.termId === row.id).map((e) => nameOf.get(e.restsOnTermId) ?? "")
          : [];
        const rests = restsOn.length ? `, rests on ${restsOn.join(" · ")}` : "";
        return `- ${row?.term ?? name} (${row?.status ?? "planned"}${rests})`;
      });
      const taught = sessions.flatMap((s, i) => {
        const introduced = [
          ...new Set(
            (s.outline?.steps ?? [])
              .flatMap((step) => step.introduces)
              .filter((term) => inArc.has(key(term))),
          ),
        ];
        if (introduced.length === 0) return [];
        const title = s.outline?.title ? ` "${s.outline.title}"` : "";
        return [`- Session ${String(i + 1)}${title}: ${introduced.join(" · ")}`];
      });
      return [
        `### ${arc.title}`,
        "",
        "Its terms:",
        ...termLines,
        "",
        ...(taught.length
          ? ["The sessions whose lessons taught them:", ...taught]
          : ["Taught before the app kept its lessons."]),
      ].join("\n");
    })
    .join("\n\n");
}

/** The exam's call, after the homework's: what to write, and in what shape. */
export const EXAM_REQUEST = `(The homework is set. This session also closed an arc of the plan (under "${EXAM_ARCS}"), so assign its arc exam now, over the whole arc, as "The arc exam" says: transfer problems in settings no lesson used, questions answerable only by connecting ideas from different sessions (the terms' "rests on" say which pairs), one build, and each fix-list item the arc closed re-tested without warning in a new setting. Nothing may be recall: never a question a lesson, a check or a homework already asked. Write it in three to five parts, each under a \`##\` heading naming what it is about (never "Part 1" or the method's words), each part one task of one kind: predict → verify, a derivation, a build, or explain it to a friend. Begin with the first part's heading (the app shows the exam's name above it), and say nothing about how long it takes. Every part stands alone, everything it needs restated in full. The app gives each part the answer boxes of its kind (predict → verify: the prediction, locked before they check; what actually happened; reconcile. A derivation: its steps, each with its because. A build: what they made, and what surprised them. Explain it to a friend: one box), so don't write blanks or headings for the answers. What a good answer demonstrates is recorded next and shown by the app; don't list it here. ${allowedBlocksLine("homework", "the exam", ["image", "audio"])} (Images and audio need the lesson's tools, which this call doesn't have.) A video or a link card only to a source from this session's research or lesson; the app checks each one opens and leaves out what doesn't.)`;

export const EXAM_RECORD_PROMPT =
  "(For the app; the learner doesn't see this.) Record the arc exam you just wrote: the kind of each of its parts, in order, a few words naming it, and what a good answer demonstrates across the whole exam.";

/** The track's arc exams not handed in yet, oldest first. An exam is never folded into anything. */
export function openExamsOf(db: Db, trackId: string) {
  return db
    .select()
    .from(assignments)
    .where(
      and(
        eq(assignments.trackId, trackId),
        eq(assignments.kind, "exam"),
        isNull(assignments.submittedAt),
      ),
    )
    .orderBy(asc(assignments.createdAt), asc(assignments.id));
}

/** The heading an open exam goes under in the probe's prompt. */
export const OPEN_EXAM = "The arc exam the learner hasn't taken yet";

/**
 * The track's open arc exams, for the probe (method.md, "The arc exam": the learner started the
 * next arc with the exam still open, so its misconception re-tests and cross-session questions
 * fold into this session's probe): each exam's parts as the learner reads them. Only exams an
 * earlier session set; null when none is open. The exam stays open, to be taken whole.
 */
export async function openExamRecord(
  db: Db,
  trackId: string,
  sessionId: string,
): Promise<string | null> {
  const open = (await openExamsOf(db, trackId)).filter((row) => row.sessionId !== sessionId);
  if (open.length === 0) return null;
  return [
    "The learner started this session with this exam still open. Fold its re-tests of the audit's misconceptions and its cross-session questions into this probe: ask about the same ideas in a fresh setting and your own words, one question at a time as the probe goes, and weigh the answers like any probe answer. Don't hand over the exam's questions, and don't mention the exam: it stays open for them to take whole.",
    ...open.map((row: AssignmentRow) =>
      [`### "${row.title}"`, row.tasks.map((task) => task.source).join("\n\n")].join("\n\n"),
    ),
  ].join("\n\n");
}

/**
 * Starting a session with an arc exam open (design §7.4): the one warning. The oldest open exam
 * not warned about yet is marked warned and returned; after that, sessions start without one.
 */
export async function warnOfOpenExam(
  db: Db,
  trackId: string,
): Promise<{ id: string; title: string } | null> {
  const [exam] = (await openExamsOf(db, trackId)).filter((row) => !row.warnedAt);
  if (!exam) return null;
  const [warned] = await db
    .update(assignments)
    .set({ warnedAt: new Date() })
    .where(and(eq(assignments.id, exam.id), isNull(assignments.warnedAt)))
    .returning({ id: assignments.id, title: assignments.title });
  return warned ?? null;
}
