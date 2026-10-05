import {
  finalStanding,
  type FinalStanding,
  type NextReading,
  type SessionPhase,
  type SourceReading,
  type TaskForm,
} from "@grounded/core";
import {
  and,
  asc,
  assignments,
  eq,
  importedLessons,
  inArray,
  learningSessions,
  lessons,
  submissions,
  terms,
  tracks,
  type Db,
} from "@grounded/db";
import { filesOf } from "./files/track-files.js";
import { nextReadings } from "./track-source.js";

/**
 * Something inside a track, listed under it in the track list (design §9.2). Every kind shares
 * these fields, so the list can order, fold and count items without knowing their kind; each kind
 * adds what its row says: sessions, their homework and arc exams (put off with a snooze, either
 * has a `due` for its "tonight" tag).
 */
interface ItemBase {
  kind: string;
  id: string;
  /** Finished: folded under "N done" in the list. */
  done: boolean;
  /** When something last happened on it (ISO time). */
  activeAt: string;
}

export interface SessionItem extends ItemBase {
  kind: "session";
  /** The session's place in the track, from 1. */
  number: number;
  phase: SessionPhase;
  /** What the session's lesson teaches: the terms its outline introduces, in order; none before. */
  terms: string[];
  /** The lesson's title; null before it is outlined (or outlined before lessons had titles). */
  lessonTitle: string | null;
  /** The track's final (design §7.4): no lesson, so its row names it. */
  final: boolean;
}

/**
 * A session's homework, listed after it: open until it is handed in, or folded into a later
 * homework (method.md, "Homework").
 */
export interface HomeworkItem extends ItemBase {
  kind: "homework";
  /** The number of the session that assigned it. */
  session: number;
  /** A few words naming it. */
  title: string;
  form: TaskForm;
  /** Put off with a snooze: when it is due again (ISO time), for its tag; null otherwise or once done. */
  due: string | null;
  /** Folded into a later homework: the number of the session that assigned that one. */
  foldedInto: number | null;
}

/**
 * An arc exam (design §7.4), listed after its session's homework: open until it is handed in. It
 * is never folded into anything.
 */
export interface ExamItem extends ItemBase {
  kind: "exam";
  /** The number of the session that closed its arc and set it. */
  session: number;
  /** A few words naming it. */
  title: string;
  /** The arcs it covers: the ones its session closed. */
  arcs: string[];
  /** How many parts it has. */
  parts: number;
  /** Put off with a snooze: when it is due again (ISO time), for its tag; null otherwise or once done. */
  due: string | null;
}

export type TrackItem = SessionItem | HomeworkItem | ExamItem;

export interface TrackSummary {
  id: string;
  title: string;
  naming: boolean;
  language: string | null;
  /** The latest activity on the track or anything in it (ISO time); the list is ordered by it. */
  activeAt: string;
  items: TrackItem[];
  openSession: { id: string; phase: SessionPhase } | null;
  /** Where the track stands towards its final (design §7.4): offered, finished… */
  final: FinalStanding;
  /** The final that finished the track, while it is finished. */
  finishedIn: string | null;
  importedLesson: { title: string } | null;
  files: {
    id: string;
    name: string;
    kind: string;
    role: "brought" | "source";
    sizeBytes: number;
  }[];
  /** A track taught from a source (design §4.6): where reading it stands; null for any other. */
  source: SourceReading | null;
  /** On a source track: the chapter to read next, once the source is read; null when none. */
  reading: NextReading | null;
}

/** When something last happened on an assignment: changed, or its answers written. */
const lastActive = (a: { updatedAt: Date; answeredAt: Date | null }) =>
  (a.answeredAt && a.answeredAt > a.updatedAt ? a.answeredAt : a.updatedAt).toISOString();

/** The learner's tracks with their items, the most recently active first (design §9.2). */
export async function trackList(db: Db, userId: string): Promise<TrackSummary[]> {
  const rows = await db.select().from(tracks).where(eq(tracks.userId, userId));
  const ids = rows.map((t) => t.id);
  // The chapter each source track's learner is asked to read next (design §4.6).
  const readings = await nextReadings(
    db,
    rows.flatMap((t) =>
      t.source?.status === "ready" && t.source.assigned !== null && t.source.assigned !== undefined
        ? [{ trackId: t.id, assigned: t.source.assigned }]
        : [],
    ),
    new Set(),
  );
  const sessions = await db
    .select({
      id: learningSessions.id,
      trackId: learningSessions.trackId,
      state: learningSessions.state,
      kind: learningSessions.kind,
      closedAt: learningSessions.closedAt,
      updatedAt: learningSessions.updatedAt,
      outline: lessons.outline,
    })
    .from(learningSessions)
    .leftJoin(lessons, eq(lessons.sessionId, learningSessions.id))
    .where(eq(learningSessions.userId, userId))
    .orderBy(asc(learningSessions.createdAt), asc(learningSessions.id));
  const imported = ids.length
    ? await db
        .select({ trackId: importedLessons.trackId, title: importedLessons.title })
        .from(importedLessons)
        .where(inArray(importedLessons.trackId, ids))
    : [];
  const attached = await filesOf(db, ids);
  // What keeps each track's plan from being taught through (design §7.4).
  const planned = ids.length
    ? await db
        .select({ trackId: terms.trackId, term: terms.term })
        .from(terms)
        .where(and(inArray(terms.trackId, ids), eq(terms.status, "planned")))
    : [];
  const assigned = await db
    .select({
      id: assignments.id,
      kind: assignments.kind,
      sessionId: assignments.sessionId,
      title: assignments.title,
      tasks: assignments.tasks,
      submittedAt: assignments.submittedAt,
      snoozedUntil: assignments.snoozedUntil,
      subsumedBy: assignments.subsumedBy,
      updatedAt: assignments.updatedAt,
      // Writing the answers is activity on it too.
      answeredAt: submissions.updatedAt,
    })
    .from(assignments)
    .leftJoin(submissions, eq(submissions.assignmentId, assignments.id))
    .where(eq(assignments.userId, userId))
    .orderBy(asc(assignments.createdAt), asc(assignments.id));
  const homework = assigned.filter((a) => a.kind === "homework");

  const now = new Date();
  const list = rows.map((track): TrackSummary => {
    const trackSessions = sessions.filter((s) => s.trackId === track.id);
    /** The number of the session that assigned this homework. */
    const sessionOf = (assignmentId: string) => {
      const assigning = homework.find((h) => h.id === assignmentId)?.sessionId;
      return trackSessions.findIndex((s) => s.id === assigning) + 1 || null;
    };
    // A due homework counts as activity once its time comes, so its track rises in the list.
    const dueTimes = assigned
      .filter((h) => trackSessions.some((s) => s.id === h.sessionId))
      .flatMap((h) =>
        h.snoozedUntil && h.snoozedUntil <= now && !h.submittedAt && !h.subsumedBy
          ? [h.snoozedUntil.toISOString()]
          : [],
      );
    const items = trackSessions.flatMap((s, index): TrackItem[] => [
      {
        kind: "session",
        id: s.id,
        number: index + 1,
        phase: s.state.phase,
        terms: [...new Set(s.outline?.steps.flatMap((step) => step.introduces) ?? [])],
        lessonTitle: s.outline?.title ?? null,
        final: s.kind === "final",
        done: s.closedAt !== null,
        activeAt: s.updatedAt.toISOString(),
      },
      ...homework
        .filter((h) => h.sessionId === s.id)
        .map((h): HomeworkItem => ({
          kind: "homework",
          id: h.id,
          session: index + 1,
          title: h.title,
          form: h.tasks[0]?.form ?? "explain",
          done: h.submittedAt !== null || h.subsumedBy !== null,
          due: h.submittedAt || h.subsumedBy ? null : (h.snoozedUntil?.toISOString() ?? null),
          foldedInto: h.subsumedBy ? sessionOf(h.subsumedBy) : null,
          activeAt: lastActive(h),
        })),
      ...assigned
        .filter((e) => e.kind === "exam" && e.sessionId === s.id)
        .map((e): ExamItem => ({
          kind: "exam",
          id: e.id,
          session: index + 1,
          title: e.title,
          arcs: track.plan.arcs.filter((arc) => arc.closedIn === s.id).map((arc) => arc.title),
          parts: e.tasks.length,
          done: e.submittedAt !== null,
          due: e.submittedAt ? null : (e.snoozedUntil?.toISOString() ?? null),
          activeAt: lastActive(e),
        })),
    ]);
    const open = items.find((item): item is SessionItem => item.kind === "session" && !item.done);
    const lesson = imported.find((l) => l.trackId === track.id);
    const latest = trackSessions.at(-1);
    const final = finalStanding({
      arcs: track.plan.arcs,
      planned: planned.filter((p) => p.trackId === track.id).map((p) => p.term),
      examsOpen: items.filter((item) => item.kind === "exam" && !item.done).length,
      latest: latest ? { final: latest.kind === "final", closed: latest.closedAt !== null } : null,
    });
    const activeAt = [track.updatedAt.toISOString(), ...items.map((i) => i.activeAt), ...dueTimes]
      .sort()
      .at(-1);
    return {
      id: track.id,
      title: track.title,
      naming: track.titlePending,
      language: track.language,
      activeAt: activeAt ?? track.updatedAt.toISOString(),
      items,
      openSession: open ? { id: open.id, phase: open.phase } : null,
      final,
      finishedIn: final === "finished" ? (latest?.id ?? null) : null,
      importedLesson: lesson ? { title: lesson.title } : null,
      files: attached.get(track.id) ?? [],
      source: track.source,
      reading: readings.find((r) => r.trackId === track.id)?.next ?? null,
    };
  });
  return list.sort((a, b) => b.activeAt.localeCompare(a.activeAt));
}
