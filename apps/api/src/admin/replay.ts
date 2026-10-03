import type { Replay, TimelineItem } from "@grounded/core/admin";
import {
  and,
  asc,
  asideMessages,
  asides,
  assignments,
  checkMessages,
  eq,
  inArray,
  learningSessions,
  lessons,
  modelCalls,
  researchNotes,
  reviewComments,
  reviewMessages,
  reviews,
  sessionEvents,
  sessionMessages,
  tracks,
  usageEvents,
  users,
  type Db,
} from "@grounded/db";
import { estimateCost } from "@grounded/providers";
import { blocksText, inlineText } from "./blocks-text.js";

/*
 * One session as it happened, for the admin panel's replay (design §10.1): what the learner saw
 * and did, in time order, with the model calls behind it between them. Everything model-written
 * is text (blocks-text.ts). A call's content is fetched on its own (calls.ts): a session's prompts
 * run to megabytes.
 */

const failureText = (failure: unknown): string | null =>
  failure === null || failure === undefined ? null : JSON.stringify(failure);

export async function replay(db: Db, sessionId: string): Promise<Replay | null> {
  const [head] = await db
    .select({
      session: learningSessions,
      track: {
        id: tracks.id,
        title: tracks.title,
        goal: tracks.goal,
        language: tracks.language,
      },
      learner: users.learnerNumber,
    })
    .from(learningSessions)
    .innerJoin(tracks, eq(tracks.id, learningSessions.trackId))
    .innerJoin(users, eq(users.id, learningSessions.userId))
    .where(eq(learningSessions.id, sessionId));
  if (!head) return null;
  const { session, track, learner } = head;

  const [messages, events, lessonRows, checks, asideRows, research, assigned, calls] =
    await Promise.all([
      db
        .select()
        .from(sessionMessages)
        .where(eq(sessionMessages.sessionId, sessionId))
        .orderBy(asc(sessionMessages.createdAt), asc(sessionMessages.id)),
      db
        .select()
        .from(sessionEvents)
        .where(
          and(
            eq(sessionEvents.sessionId, sessionId),
            inArray(sessionEvents.type, ["state", "error", "lesson-step", "lesson-outline"]),
          ),
        )
        .orderBy(asc(sessionEvents.id)),
      db.select().from(lessons).where(eq(lessons.sessionId, sessionId)),
      db
        .select()
        .from(checkMessages)
        .where(eq(checkMessages.sessionId, sessionId))
        .orderBy(asc(checkMessages.createdAt), asc(checkMessages.id)),
      db
        .select()
        .from(asides)
        .where(eq(asides.sessionId, sessionId))
        .orderBy(asc(asides.createdAt)),
      db
        .select()
        .from(researchNotes)
        .where(eq(researchNotes.sessionId, sessionId))
        .orderBy(asc(researchNotes.createdAt)),
      db
        .select()
        .from(assignments)
        .leftJoin(reviews, eq(reviews.assignmentId, assignments.id))
        .where(eq(assignments.sessionId, sessionId))
        .orderBy(asc(assignments.createdAt)),
      db
        .select({
          usage: usageEvents,
          stored: modelCalls.usageEventId,
          verdict: modelCalls.verdict,
        })
        .from(usageEvents)
        .leftJoin(modelCalls, eq(modelCalls.usageEventId, usageEvents.id))
        .where(eq(usageEvents.sessionId, sessionId))
        .orderBy(asc(usageEvents.createdAt), asc(usageEvents.id)),
    ]);

  const asideThreads = asideRows.length
    ? await db
        .select()
        .from(asideMessages)
        .where(
          inArray(
            asideMessages.asideId,
            asideRows.map((a) => a.id),
          ),
        )
        .orderBy(asc(asideMessages.createdAt), asc(asideMessages.id))
    : [];
  const reviewIds = assigned.flatMap((row) => (row.reviews ? [row.reviews.id] : []));
  const comments = reviewIds.length
    ? await db
        .select({ comment: reviewComments, message: reviewMessages })
        .from(reviewComments)
        .leftJoin(reviewMessages, eq(reviewMessages.commentId, reviewComments.id))
        .where(inArray(reviewComments.reviewId, reviewIds))
        .orderBy(asc(reviewComments.position), asc(reviewMessages.createdAt))
    : [];

  const timeline: TimelineItem[] = [];
  const at = (date: Date) => date.toISOString();

  for (const m of messages)
    timeline.push({
      at: at(m.createdAt),
      kind: "message",
      role: m.role,
      messageKind: m.kind,
      text: m.role === "tutor" && m.blocks ? blocksText(m.blocks) : (m.text ?? ""),
    });

  let phase: string | null = null;
  const stepShownAt = new Map<string, Date>();
  let outlineAt: Date | null = null;
  for (const e of events) {
    const data = e.data as Record<string, unknown> | null;
    if (e.type === "state") {
      const next = typeof data?.phase === "string" ? data.phase : null;
      if (next && next !== phase)
        timeline.push({ at: at(e.createdAt), kind: "phase", phase: next });
      phase = next ?? phase;
    } else if (e.type === "error")
      timeline.push({
        at: at(e.createdAt),
        kind: "error",
        message: typeof data?.message === "string" ? data.message : JSON.stringify(data),
      });
    else if (e.type === "lesson-outline") outlineAt ??= e.createdAt;
    else {
      const step = data?.step as { id?: unknown } | undefined;
      if (typeof step?.id === "string" && !stepShownAt.has(step.id))
        stepShownAt.set(step.id, e.createdAt);
    }
  }
  if (session.closedAt) timeline.push({ at: at(session.closedAt), kind: "phase", phase: "closed" });

  const [lesson] = lessonRows;
  if (lesson?.outline)
    timeline.push({
      at: at(outlineAt ?? lesson.createdAt),
      kind: "outline",
      title: lesson.outline.title ?? null,
      steps: lesson.outline.steps.map((s) => ({
        heading: s.heading,
        establishes: s.establishes,
        introduces: s.introduces,
        restsOn: s.restsOn,
      })),
    });
  for (const step of lesson?.steps ?? [])
    timeline.push({
      at: at(stepShownAt.get(step.id) ?? lesson?.createdAt ?? session.createdAt),
      kind: "step",
      stepId: step.id,
      heading: inlineText(step.heading),
      text: blocksText([...step.body, ...(step.check ? [step.check] : [])]),
      source: lesson?.stepSources[step.id] ?? null,
    });

  for (const c of checks)
    timeline.push({
      at: at(c.createdAt),
      kind: "check",
      stepId: c.stepId,
      role: c.role,
      text: c.role === "tutor" && c.blocks ? blocksText(c.blocks) : (c.text ?? ""),
      verdict: c.verdict,
      failure: failureText(c.failure),
    });

  for (const a of asideRows)
    timeline.push({
      at: at(a.createdAt),
      kind: "aside",
      stepId: a.stepId,
      quote: a.anchor.quote,
      tangent: a.tangent,
      thread: asideThreads
        .filter((m) => m.asideId === a.id)
        .map((m) => ({
          role: m.role,
          text: m.role === "tutor" && m.blocks ? blocksText(m.blocks) : m.text,
          failure: failureText(m.failure),
        })),
    });

  for (const r of research)
    timeline.push({
      at: at(r.createdAt),
      kind: "research",
      for: r.kind,
      notes: r.notes,
      searches: r.searches,
      sources: r.sources.length,
    });

  for (const { assignments: a, reviews: review } of assigned) {
    const own = comments.filter((c) => c.comment.reviewId === review?.id);
    const commentIds = [...new Set(own.map((c) => c.comment.id))];
    timeline.push({
      at: at(a.createdAt),
      kind: "assignment",
      assignmentKind: a.kind,
      title: a.title,
      tasks: a.tasks.map((task) => task.source),
      checklist: a.checklist.map((item) => `${item.id}: ${item.text}`),
      submittedAt: a.submittedAt ? at(a.submittedAt) : null,
      snoozedUntil: a.snoozedUntil ? at(a.snoozedUntil) : null,
      folded: a.subsumedBy !== null,
      review: review
        ? {
            status: review.status,
            marks: review.checklist.map((m) => ({ item: m.id, mark: m.mark, note: m.note })),
            comments: commentIds.map((id) => {
              const thread = own.filter((c) => c.comment.id === id);
              return {
                quote: thread[0]?.comment.anchor.quote ?? "",
                thread: thread.flatMap((c) =>
                  c.message
                    ? [
                        {
                          role: c.message.role,
                          text:
                            c.message.role === "tutor" && c.message.blocks
                              ? blocksText(c.message.blocks)
                              : c.message.text,
                        },
                      ]
                    : [],
                ),
              };
            }),
          }
        : null,
    });
  }

  for (const { usage: u, stored, verdict } of calls)
    timeline.push({
      at: at(u.createdAt),
      kind: "call",
      call: {
        id: u.id,
        purpose: u.purpose,
        model: u.model,
        status: u.status,
        errorKind: u.errorKind,
        durationMs: u.durationMs,
        inputTokens: u.inputTokens,
        cachedInputTokens: u.cachedInputTokens,
        outputTokens: u.outputTokens,
        costUsd: estimateCost(u.model, u),
        methodVersion: u.methodVersion,
        stored: stored !== null,
        verdict,
      },
    });

  // In time order; at the same moment, as the list above puts them (a stable sort).
  timeline.sort((a, b) => a.at.localeCompare(b.at));

  return {
    session: {
      id: session.id,
      learner,
      kind: session.kind,
      phase: session.closedAt ? "closed" : session.state.phase,
      startedAt: at(session.createdAt),
      closedAt: session.closedAt ? at(session.closedAt) : null,
      probeSummary: session.probeSummary,
      reviewSummary: session.reviewSummary,
      earlierSummary: session.earlierSummary,
    },
    track,
    lesson: lesson
      ? {
          steps: session.state.lesson.steps.map((s) => ({
            id: s.id,
            status: session.state.steps[s.id]?.status ?? "unknown",
            misses: session.state.steps[s.id]?.misses ?? 0,
          })),
          failedSteps: lesson.failedSteps,
          notes: lesson.notes,
          alreadyHeld: lesson.alreadyHeld,
        }
      : null,
    timeline,
  };
}
