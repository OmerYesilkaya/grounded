import type { LessonOutline, SessionState } from "@grounded/core";
import {
  asc,
  checkMessages,
  eq,
  learningSessions,
  lessons,
  sessionEvents,
  sessionMessages,
  terms,
  tracks,
  usageEvents,
  type Db,
} from "@grounded/db";

/** Everything one eval session left in the database, read back for the transcript and the scores. */
export interface RunRecord {
  goal: string;
  state: SessionState;
  messages: { role: string; kind: string; text: string }[];
  probeSummary: string | null;
  plan: { arcs: { title: string; terms: string[] }[]; notes: string };
  leftOff: string | null;
  lesson: {
    outline: LessonOutline | null;
    sources: Record<string, string>;
    notes: Record<string, string>;
    alreadyHeld: Record<string, string>;
    failedSteps: { stepId: string; heading: string }[];
  } | null;
  checks: { stepId: string; role: string; text: string; verdict: string | null }[];
  usage: {
    purpose: string;
    model: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    status: string;
    durationMs: number | null;
  }[];
  /** Activity labels, in the order they started. */
  activities: string[];
  errors: string[];
  terms: { term: string; status: string }[];
}

export async function readRecord(db: Db, sessionId: string): Promise<RunRecord> {
  const [session] = await db
    .select()
    .from(learningSessions)
    .where(eq(learningSessions.id, sessionId));
  if (!session) throw new Error(`no session ${sessionId}`);
  const [track] = await db.select().from(tracks).where(eq(tracks.id, session.trackId));
  if (!track) throw new Error(`no track for session ${sessionId}`);
  const [lesson] = await db.select().from(lessons).where(eq(lessons.sessionId, sessionId));
  const messages = await db
    .select()
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(asc(sessionMessages.createdAt), asc(sessionMessages.id));
  const threads = await db
    .select()
    .from(checkMessages)
    .where(eq(checkMessages.sessionId, sessionId))
    .orderBy(asc(checkMessages.createdAt), asc(checkMessages.id));
  const events = await db
    .select()
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, sessionId))
    .orderBy(asc(sessionEvents.id));
  const usage = await db
    .select()
    .from(usageEvents)
    .where(eq(usageEvents.userId, session.userId))
    .orderBy(asc(usageEvents.createdAt));
  const termRows = await db.select().from(terms).where(eq(terms.trackId, session.trackId));

  const activities = events
    .filter((e) => e.type === "activity" && (e.data as { state?: string }).state === "running")
    .map((e) => (e.data as { label: string }).label);
  const errors = events
    .filter((e) => e.type === "error")
    .map((e) => (e.data as { message: string }).message);

  return {
    goal: track.goal,
    state: session.state,
    messages: messages.map((m) => ({ role: m.role, kind: m.kind, text: m.text ?? "" })),
    probeSummary: session.probeSummary,
    plan: track.plan,
    leftOff: track.leftOff,
    lesson: lesson
      ? {
          outline: lesson.outline,
          sources: lesson.stepSources,
          notes: lesson.notes,
          alreadyHeld: lesson.alreadyHeld,
          failedSteps: lesson.failedSteps,
        }
      : null,
    checks: threads.map((m) => ({
      stepId: m.stepId,
      role: m.role,
      text: m.text ?? "",
      verdict: m.verdict,
    })),
    usage: usage.map((u) => ({
      purpose: u.purpose,
      model: u.model,
      inputTokens: u.inputTokens,
      cachedInputTokens: u.cachedInputTokens,
      outputTokens: u.outputTokens,
      status: u.status,
      durationMs: u.durationMs,
    })),
    activities,
    errors,
    terms: termRows
      .map((t) => ({ term: t.term, status: t.status }))
      .sort((a, b) => a.term.localeCompare(b.term)),
  };
}
