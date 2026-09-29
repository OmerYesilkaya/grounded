import {
  AFTER_THE_LOCK,
  ANSWER_LIMITS,
  ATTACHMENT_LIMITS,
  answerProblem,
  isTimeZone,
  snoozeUntil,
  SNOOZES,
  type TaskAnswer,
} from "@grounded/core";
import {
  and,
  answerFiles,
  assignments,
  desc,
  eq,
  isNull,
  learningSessions,
  lte,
  sessionEvents,
  sql,
  submissions,
  tracks,
  type Db,
} from "@grounded/db";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import {
  closeAfterHomework,
  closedReason,
  publishAssignment,
  snoozeAssignment,
  type AssignmentRow,
} from "../engine/assignments.js";
import type { JobQueue } from "../engine/queue.js";
import { loadSession } from "../engine/session-store.js";
import { imageType } from "../files/attachments.js";
import { FileNotFound, type FileStore } from "../files/store.js";
import { addLogContext } from "../log.js";

interface Env {
  Variables: { user: { id: string; email: string; name: string } };
}

const answerInput = z.object({
  taskId: z.string().min(1),
  fields: z.record(z.string(), z.string()),
});

const laterInput = z.object({
  snooze: z.enum(SNOOZES),
  // The learner's time zone, from their browser: what "tonight" and "tomorrow" mean.
  timeZone: z.string().max(100).refine(isTimeZone),
});

/**
 * Homework and arc exams (design §7.4): reading one, writing its answers (saved as the learner
 * writes), locking a prediction, adding pictures, and handing it in.
 */
export function registerAssignmentRoutes(
  app: Hono<Env>,
  deps: { db: Db; queue: JobQueue; files: FileStore },
) {
  const { db, files } = deps;

  const ownAssignment = async (userId: string, assignmentId: string) => {
    if (!z.uuid().safeParse(assignmentId).success) return null;
    const [row] = await db
      .select()
      .from(assignments)
      .where(and(eq(assignments.id, assignmentId), eq(assignments.userId, userId)));
    if (row)
      addLogContext({ trackId: row.trackId, sessionId: row.sessionId, assignmentId: row.id });
    return row ?? null;
  };

  /** Why an assignment found open a moment ago can't be changed now. */
  const closedMeanwhile = async (assignmentId: string) => {
    const [row] = await db
      .select({ submittedAt: assignments.submittedAt, subsumedBy: assignments.subsumedBy })
      .from(assignments)
      .where(eq(assignments.id, assignmentId));
    return (row && closedReason(row)) ?? "This homework is closed.";
  };

  const answersOf = async (assignmentId: string) => {
    const [row] = await db
      .select({ answers: submissions.answers })
      .from(submissions)
      .where(eq(submissions.assignmentId, assignmentId));
    return row?.answers ?? {};
  };

  /**
   * Changes one task's answer, holding the submission's row so two saves never interleave: `change`
   * gets the answer as it is and returns it as it should be, or a problem for the learner.
   */
  const changeAnswer = (
    assignment: AssignmentRow,
    taskId: string,
    change: (answer: TaskAnswer) => TaskAnswer | string,
  ) =>
    db.transaction(async (tx) => {
      await tx.insert(submissions).values({ assignmentId: assignment.id }).onConflictDoNothing();
      const [row] = await tx
        .select({ answers: submissions.answers })
        .from(submissions)
        .where(eq(submissions.assignmentId, assignment.id))
        .for("update");
      // Handed in (or folded into a later homework) meanwhile: the answers stand as they were.
      const [current] = await tx
        .select({ submittedAt: assignments.submittedAt, subsumedBy: assignments.subsumedBy })
        .from(assignments)
        .where(eq(assignments.id, assignment.id));
      const closed = current ? closedReason(current) : null;
      if (closed) return closed;
      const answers = row?.answers ?? {};
      const changed = change(answers[taskId] ?? { fields: {}, lockedAt: null });
      if (typeof changed === "string") return changed;
      await tx
        .update(submissions)
        .set({ answers: { ...answers, [taskId]: changed } })
        .where(eq(submissions.assignmentId, assignment.id));
      return changed;
    });

  app.get("/api/assignments/:id", async (c) => {
    const assignment = await ownAssignment(c.get("user").id, c.req.param("id"));
    if (!assignment) return c.json({ error: "Not found." }, 404);
    // The cursor of its session's log, read first: the page follows that log from here (its
    // review arrives there), and anything published meanwhile is replayed, not skipped.
    const [last] = await db
      .select({ id: sessionEvents.id })
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, assignment.sessionId))
      .orderBy(desc(sessionEvents.id))
      .limit(1);
    const [fresh] = await db.select().from(assignments).where(eq(assignments.id, assignment.id));
    const row = fresh ?? assignment;
    const [track] = await db
      .select({ title: tracks.title })
      .from(tracks)
      .where(eq(tracks.id, row.trackId));
    const session = await loadSession(db, row.sessionId);
    const [{ number } = { number: 0 }] = await db
      .select({ number: sql<number>`count(*)::int` })
      .from(learningSessions)
      .where(
        and(
          eq(learningSessions.trackId, row.trackId),
          // Compared in the database: its times are finer than a Date's milliseconds.
          lte(
            learningSessions.createdAt,
            sql`(select created_at from learning_sessions where id = ${row.sessionId})`,
          ),
        ),
      );
    return c.json({
      id: row.id,
      trackId: row.trackId,
      trackTitle: track?.title ?? "",
      sessionId: row.sessionId,
      // Its place in the track, and whether it waits for this homework to go on to its close.
      session: {
        number,
        waiting:
          row.kind === "homework" &&
          session.state.phase === "homework" &&
          session.state.homework === "assigned",
      },
      kind: row.kind,
      title: row.title,
      tasks: row.tasks.map(({ id, title, form, blocks }) => ({ id, title, form, blocks })),
      checklist: row.checklist,
      answers: await answersOf(row.id),
      createdAt: row.createdAt.toISOString(),
      submittedAt: row.submittedAt?.toISOString() ?? null,
      snoozedUntil: row.snoozedUntil?.toISOString() ?? null,
      // The homework it was folded into, which covers its ground: the page links to it.
      subsumedBy: row.subsumedBy
        ? ((
            await db
              .select({ id: assignments.id, title: assignments.title })
              .from(assignments)
              .where(eq(assignments.id, row.subsumedBy))
          )[0] ?? null)
        : null,
      lastEventId: last?.id ?? 0,
    });
  });

  // One task's answer as the learner has written it so far: saved as they write.
  app.put("/api/assignments/:id/answers", async (c) => {
    const assignment = await ownAssignment(c.get("user").id, c.req.param("id"));
    if (!assignment) return c.json({ error: "Not found." }, 404);
    const parsed = answerInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Write an answer first." }, 400);
    const task = assignment.tasks.find((t) => t.id === parsed.data.taskId);
    if (!task) return c.json({ error: "That task isn't in this assignment." }, 404);
    const saved = await changeAnswer(assignment, task.id, (answer) => {
      const fields = parsed.data.fields;
      if (task.form === "predict") {
        // A locked prediction stands as it was locked; what comes after it waits for the lock.
        if (answer.lockedAt && (fields.prediction ?? "") !== (answer.fields.prediction ?? ""))
          return "Your prediction is locked.";
        if (!answer.lockedAt && AFTER_THE_LOCK.some((key) => fields[key]?.trim()))
          return "Lock your prediction before you check it.";
      }
      const next = { ...answer, fields };
      return answerProblem(task, next, { complete: false }) ?? next;
    });
    if (typeof saved === "string") return c.json({ error: saved }, 409);
    return c.json(saved);
  });

  // Predict → verify: the prediction locks, with the time, before the learner checks it.
  app.post("/api/assignments/:id/tasks/:taskId/lock", async (c) => {
    const assignment = await ownAssignment(c.get("user").id, c.req.param("id"));
    if (!assignment) return c.json({ error: "Not found." }, 404);
    const task = assignment.tasks.find((t) => t.id === c.req.param("taskId"));
    if (task?.form !== "predict") return c.json({ error: "There is no prediction to lock." }, 404);
    const locked = await changeAnswer(assignment, task.id, (answer) => {
      if (answer.lockedAt) return answer;
      if (!answer.fields.prediction?.trim()) return "Write your prediction first.";
      return { ...answer, lockedAt: new Date().toISOString() };
    });
    if (typeof locked === "string") return c.json({ error: locked }, 409);
    return c.json(locked);
  });

  const pictureLimit = bodyLimit({
    maxSize: ATTACHMENT_LIMITS.imageBytes + 64 * 1024,
    onError: (c) => c.json({ error: "A picture can be at most 5 MB." }, 413),
  });

  // A picture for an answer (a photo of a notebook page): stored, then linked from the markdown.
  app.post("/api/assignments/:id/files", pictureLimit, async (c) => {
    const assignment = await ownAssignment(c.get("user").id, c.req.param("id"));
    if (!assignment) return c.json({ error: "Not found." }, 404);
    const closed = closedReason(assignment);
    if (closed) return c.json({ error: closed }, 409);
    const form = await c.req.parseBody().catch(() => null);
    const file = form?.file;
    if (!(file instanceof File)) return c.json({ error: "Choose a picture." }, 400);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mediaType = imageType(bytes);
    if (!mediaType)
      return c.json({ error: "Only pictures (PNG, JPEG, WebP or GIF) can go in an answer." }, 400);
    if (bytes.length > ATTACHMENT_LIMITS.imageBytes)
      return c.json({ error: "A picture can be at most 5 MB." }, 413);
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(answerFiles)
      .where(eq(answerFiles.assignmentId, assignment.id));
    if ((count?.n ?? 0) >= ANSWER_LIMITS.pictures)
      return c.json(
        { error: `At most ${String(ANSWER_LIMITS.pictures)} pictures can go in one assignment.` },
        409,
      );
    const id = uuidv7();
    const storageKey = `tracks/${assignment.trackId}/answers/${id}`;
    // The bytes first, so a row never names bytes that aren't there.
    await files.put(storageKey, bytes, mediaType);
    await db
      .insert(answerFiles)
      .values({ id, assignmentId: assignment.id, mediaType, sizeBytes: bytes.length, storageKey });
    return c.json({ id, url: `/api/assignments/${assignment.id}/files/${id}` }, 201);
  });

  /**
   * A picture of an answer, for its owner only. Shown inline, unlike a track's files: it is always
   * an image (checked by its bytes when it was added) and served as the type its bytes say, with
   * nosniff, so it can't be read as anything else.
   */
  app.get("/api/assignments/:id/files/:fileId", async (c) => {
    const assignment = await ownAssignment(c.get("user").id, c.req.param("id"));
    const fileId = c.req.param("fileId");
    if (!assignment || !z.uuid().safeParse(fileId).success)
      return c.json({ error: "Not found." }, 404);
    const [file] = await db
      .select()
      .from(answerFiles)
      .where(and(eq(answerFiles.id, fileId), eq(answerFiles.assignmentId, assignment.id)));
    if (!file) return c.json({ error: "Not found." }, 404);
    let bytes: Uint8Array;
    try {
      bytes = await files.get(file.storageKey);
    } catch (error) {
      if (error instanceof FileNotFound) return c.json({ error: "Not found." }, 404);
      throw error;
    }
    return c.body(bytes.slice(), 200, {
      "content-type": file.mediaType,
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
      "cache-control": "private, max-age=31536000, immutable",
    });
  });

  // Handing it in: whole, never half-done (method.md, "The arc exam").
  app.post("/api/assignments/:id/submit", async (c) => {
    const assignment = await ownAssignment(c.get("user").id, c.req.param("id"));
    if (!assignment) return c.json({ error: "Not found." }, 404);
    const closed = closedReason(assignment);
    if (closed) return c.json({ error: closed }, 409);
    const answers = await answersOf(assignment.id);
    for (const task of assignment.tasks) {
      const problem = answerProblem(task, answers[task.id], { complete: true });
      if (problem) return c.json({ error: problem }, 409);
    }
    const [submitted] = await db
      .update(assignments)
      .set({ submittedAt: new Date() })
      .where(
        and(
          eq(assignments.id, assignment.id),
          isNull(assignments.submittedAt),
          isNull(assignments.subsumedBy),
        ),
      )
      .returning();
    if (!submitted) return c.json({ error: await closedMeanwhile(assignment.id) }, 409);
    await publishAssignment(db, submitted);
    await closeAfterHomework(db, deps.queue, submitted, "homework-handed-in");
    return c.json({ submittedAt: submitted.submittedAt?.toISOString() ?? null });
  });

  /**
   * "Later" with a snooze: the learner puts the homework off until tonight or tomorrow, in their
   * time zone, never skips it (design §3.2, §7.4). What they wrote so far stays; while its session
   * waits for it, the session goes on to its close. Open homework can be put off again.
   */
  app.post("/api/assignments/:id/later", async (c) => {
    const assignment = await ownAssignment(c.get("user").id, c.req.param("id"));
    if (!assignment) return c.json({ error: "Not found." }, 404);
    const closed = closedReason(assignment);
    if (closed) return c.json({ error: closed }, 409);
    const parsed = laterInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Choose when: tonight or tomorrow." }, 400);
    const until = snoozeUntil(parsed.data.snooze, new Date(), parsed.data.timeZone);
    if (!until) return c.json({ error: "Tonight is over; choose tomorrow." }, 409);
    const snoozed = await snoozeAssignment(db, assignment, until);
    if (!snoozed) return c.json({ error: await closedMeanwhile(assignment.id) }, 409);
    await closeAfterHomework(db, deps.queue, snoozed, "homework-later");
    return c.json({ snoozedUntil: until.toISOString() });
  });
}
