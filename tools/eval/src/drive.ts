import type { Embedded } from "@grounded/api/embedded";
import {
  asc,
  checkMessages,
  eq,
  learningSessions,
  lessons,
  sessionEvents,
  sessionMessages,
  sql,
} from "@grounded/db";
import type { Learner } from "./learner.js";
import { TASKS } from "./learner.js";

export interface DriveOptions {
  backend: Embedded;
  cookie: string;
  goal: string;
  learner: Learner;
  /** How long the backend may work on one turn before the run counts as stalled. */
  turnTimeoutMs?: number;
  /** Plan revisions the learner may ask for before approving anyway. */
  maxPlanRevisions?: number;
  /** A line per learner move, for the console. */
  onProgress?: (line: string) => void;
}

export class DriveError extends Error {}

/**
 * Plays one session from the learner's side, through the real API: answers the probe, reacts to the
 * plan, reads the lesson and answers its checks (continuing past a still-shaky one), until the
 * session closes. Returns the session's id; everything else is read back from the database.
 */
export async function driveSession(options: DriveOptions): Promise<string> {
  const { backend, cookie, learner } = options;
  const { db } = backend;
  const turnTimeoutMs = options.turnTimeoutMs ?? 8 * 60_000;
  const maxPlanRevisions = options.maxPlanRevisions ?? 1;
  const progress = options.onProgress ?? (() => undefined);

  const post = async (path: string, body?: object) => {
    const response = await backend.request(path, {
      method: "POST",
      cookie,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new DriveError(`${path} answered ${String(response.status)}: ${await response.text()}`);
    return (await response.json()) as { id: string };
  };

  const track = await post("/api/tracks", { goal: options.goal });
  await backend.startWorker();
  const { id: sessionId } = await post(`/api/tracks/${track.id}/sessions`);

  /** The backend has nothing running or due: every job this turn started is done. */
  const settled = async () => {
    const [due] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from graphile_worker.jobs where (locked_at is not null or run_at <= now()) and attempts < max_attempts`,
    );
    return (due?.n ?? 0) === 0 && (await backend.workerIdle());
  };
  let errorsSeen = 0;
  const failIfErrored = async () => {
    const errors = await db
      .select()
      .from(sessionEvents)
      .where(sql`${sessionEvents.sessionId} = ${sessionId} and ${sessionEvents.type} = 'error'`);
    if (errors.length > errorsSeen)
      throw new DriveError(
        `the app showed an error: ${(errors.at(-1)?.data as { message?: string }).message ?? ""}`,
      );
    errorsSeen = errors.length;
  };
  const waitForTurn = async () => {
    try {
      await backend.waitFor(async () => {
        await failIfErrored();
        return settled();
      }, turnTimeoutMs);
    } catch (error) {
      if (error instanceof DriveError) throw error;
      throw new DriveError(`the backend was still working after ${String(turnTimeoutMs / 1000)} s`);
    }
  };

  // What the learner has seen, in order: the chat, then each lesson step as it is read.
  const read = new Set<string>();
  const seen = async () => {
    const messages = await db
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(asc(sessionMessages.createdAt), asc(sessionMessages.id));
    const chat = messages
      .map((m) => `${m.role === "tutor" ? "Tutor" : "You"}: ${m.text ?? ""}`)
      .join("\n\n");
    const [lesson] = await db.select().from(lessons).where(eq(lessons.sessionId, sessionId));
    const threads = await db
      .select()
      .from(checkMessages)
      .where(eq(checkMessages.sessionId, sessionId))
      .orderBy(asc(checkMessages.createdAt), asc(checkMessages.id));
    const steps = [...read].map((id) => {
      const thread = threads
        .filter((m) => m.stepId === id)
        .map((m) => `${m.role === "tutor" ? "Tutor" : "You"}: ${m.text ?? ""}`);
      return [lesson?.stepSources[id] ?? "", ...(thread.length ? ["", ...thread] : [])].join("\n");
    });
    return [chat, ...(steps.length ? ["## The lesson", ...steps] : [])].join("\n\n");
  };

  let revisions = 0;
  for (;;) {
    await waitForTurn();
    const [session] = await db
      .select()
      .from(learningSessions)
      .where(eq(learningSessions.id, sessionId));
    if (!session) throw new DriveError("the session disappeared");
    const { state } = session;

    if (state.phase === "closed") return sessionId;

    if (state.phase === "probe") {
      const text = await learner.reply(await seen(), TASKS.chat);
      progress(`probe: ${text}`);
      await post(`/api/sessions/${sessionId}/messages`, { text });
      continue;
    }

    if (state.phase === "plan" && state.plan === "proposed") {
      const reaction = await learner.reply(await seen(), TASKS.plan);
      if (/^\s*APPROVE\b/.test(reaction) || revisions >= maxPlanRevisions) {
        progress("plan: approved");
        await post(`/api/sessions/${sessionId}/approve-plan`);
      } else {
        revisions += 1;
        progress(`plan: ${reaction}`);
        await post(`/api/sessions/${sessionId}/messages`, { text: reaction });
      }
      continue;
    }

    if (state.phase === "lesson" && state.lesson.status === "failed")
      throw new DriveError("the lesson failed to be written");

    if (state.phase === "lesson" && state.lesson.status === "ready" && state.currentStep) {
      const current = state.currentStep;
      const step = state.steps[current];
      const [lesson] = await db.select().from(lessons).where(eq(lessons.sessionId, sessionId));
      if (!lesson?.steps.some((s) => s.id === current))
        throw new DriveError(`step ${current} was never written`);
      // Everything up to the step being checked is open to read.
      for (const info of state.lesson.steps) {
        read.add(info.id);
        if (info.id === current) break;
      }
      if (step?.offerGate) {
        progress(`${current}: continue anyway`);
        await post(`/api/sessions/${sessionId}/steps/${current}/continue`);
        continue;
      }
      if (step?.status === "paused") throw new DriveError(`step ${current} is paused`);
      const text = await learner.reply(await seen(), TASKS.check);
      progress(`${current}: ${text}`);
      await post(`/api/sessions/${sessionId}/steps/${current}/answer`, { text });
      continue;
    }

    // Settled with nothing for the learner to do: the session is stuck.
    throw new DriveError(
      `stalled: phase ${state.phase}, plan ${state.plan}, lesson ${state.lesson.status}, current step ${String(state.currentStep)}`,
    );
  }
}
