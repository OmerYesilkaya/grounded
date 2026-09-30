import {
  assembleSystemPrompt,
  PROBE_VERDICT_PROMPT,
  probeAnswers,
  probePart,
  probeVerdictSchema,
  verdictOffered,
  verdictText,
  type Method,
  type ProbeVerdict,
} from "@grounded/core";
import type { Issue, TrackTerm } from "@grounded/content";
import {
  and,
  asc,
  eq,
  fixListItems,
  isNull,
  learningSessions,
  lessons,
  or,
  sessionMessages,
  sql,
  termEvents,
  terms,
  tracks,
  type Db,
} from "@grounded/db";
import { generateText, Output, type ModelMessage } from "ai";
import type { Task, TaskList } from "graphile-worker";
import { trackFileRows } from "../files/track-files.js";
import { addLogContext, content, log } from "../log.js";
import { filesLine, isFirstSession } from "./brought.js";
import { systemMessages } from "./call-options.js";
import { traced, verdictIssues } from "./call-trace.js";
import { chatIssues } from "./chat.js";
import { conversationFor } from "./conversation.js";
import { publish } from "./events.js";
import { NoCredentialError, ProviderCallError, type ModelAccess } from "./model-call.js";
import { jobWaiting, reportHandledFailure, type JobQueue } from "./queue.js";
import { createReviewer } from "./review.js";
import { unlessWorkedOn } from "./work-locks.js";

/*
 * "See where you stand" (design §7.1, #61): after a track's first probe, the learner may ask what
 * it found. A call of its own writes it for them, from the probe's conversation and what the probe
 * recorded, once, when they ask; it is checked like a chat message, stored on the session, and
 * shown at the seam between the probe and the plan, and on the track page as "Where you started".
 * The probe's summary for the plan (`probe_summary`) is not it: that one is the tutor's.
 */

type Session = typeof learningSessions.$inferSelect;

/** Where the verdict stands, as the session snapshot and the `probe-verdict` event give it. */
export interface VerdictState {
  /** offered: the learner hasn't asked yet. */
  status: "offered" | "writing" | "written" | "failed";
  verdict: ProbeVerdict | null;
  /** Why it couldn't be written, when it failed. */
  failure: string | null;
}

const INTERRUPTED = "Writing it was interrupted by a problem on our side.";
const WENT_WRONG = "Something went wrong on our side.";

/** The session's verdict as it stands, or null when none is offered. */
export async function verdictState(db: Db, session: Session): Promise<VerdictState | null> {
  if (session.probeVerdictStatus === null && !(await offered(db, session))) return null;
  return {
    status: session.probeVerdictStatus ?? "offered",
    verdict: session.probeVerdict,
    failure: session.probeVerdictFailure,
  };
}

/** Whether "See where you stand" is offered in the session (core's `verdictOffered`). */
async function offered(db: Db, session: Session): Promise<boolean> {
  const chat = await db
    .select({ role: sessionMessages.role, kind: sessionMessages.kind })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, session.id))
    .orderBy(asc(sessionMessages.createdAt), asc(sessionMessages.id));
  return verdictOffered({
    final: session.kind === "final",
    first: await isFirstSession(db, session.id, session.trackId),
    phase: session.state.phase,
    answers: probeAnswers(chat),
  });
}

async function publishVerdict(db: Db, sessionId: string): Promise<VerdictState | null> {
  const [session] = await db
    .select()
    .from(learningSessions)
    .where(eq(learningSessions.id, sessionId));
  if (!session) return null;
  const state = await verdictState(db, session);
  if (state) await publish(db, sessionId, "probe-verdict", state);
  return state;
}

export type AskResult = { ok: true; state: VerdictState } | { ok: false; reason: string };

/**
 * The learner asked to see where they stand: the verdict's job is queued, unless it is written or
 * being written already. Asked again after it failed, it is written again.
 */
export async function askForVerdict(db: Db, queue: JobQueue, session: Session): Promise<AskResult> {
  const state = await verdictState(db, session);
  if (!state) return { ok: false, reason: "There is nothing to show yet." };
  if (state.status === "written" || state.status === "writing") return { ok: true, state };
  // Only the first of two taps at once queues the job.
  const [claimed] = await db
    .update(learningSessions)
    .set({ probeVerdictStatus: "writing", probeVerdictFailure: null, probeVerdictAt: new Date() })
    .where(
      and(
        eq(learningSessions.id, session.id),
        or(
          isNull(learningSessions.probeVerdictStatus),
          eq(learningSessions.probeVerdictStatus, "failed"),
        ),
      ),
    )
    .returning({ id: learningSessions.id });
  // Recovery leaves a verdict asked for moments ago to its job, which is queued next.
  const now = claimed ? await publishVerdict(db, session.id) : null;
  if (claimed) await queue.enqueue("probe-verdict", { sessionId: session.id });
  return { ok: true, state: now ?? { ...state, status: "writing", failure: null } };
}

const HELD = new Set(["confirmed", "assumed"]);

/**
 * Whether a record was made while the session's records were the probe's: from its start until its
 * lesson (the plan's record adds the misconceptions the probe found), or its close without one.
 * Compared in the database, at its precision: a JavaScript Date keeps only milliseconds.
 */
const inProbe = (
  column: typeof termEvents.createdAt | typeof fixListItems.createdAt,
  sessionId: string,
) => {
  const session = (field: string) =>
    sql`(select ${sql.raw(field)} from ${learningSessions} where ${learningSessions.id} = ${sessionId})`;
  const lesson = sql`(select ${lessons.createdAt} from ${lessons} where ${lessons.sessionId} = ${sessionId})`;
  return sql`${column} between ${session("created_at")} and coalesce(${lesson}, ${session("closed_at")}, 'infinity')`;
};

/**
 * What the probe recorded: the evidence on the learner's terms and the misconceptions it noted,
 * oldest first. The track as it is now would carry what later sessions taught.
 */
async function probeRecords(db: Db, session: Session) {
  const events = await db
    .select({
      term: terms.term,
      status: termEvents.toStatus,
      evidence: termEvents.evidence,
    })
    .from(termEvents)
    .innerJoin(terms, eq(terms.id, termEvents.termId))
    .where(
      and(
        eq(terms.trackId, session.trackId),
        eq(termEvents.source, "probe"),
        inProbe(termEvents.createdAt, session.id),
      ),
    )
    .orderBy(asc(termEvents.createdAt), asc(termEvents.id));
  const misconceptions = await db
    .select({ text: fixListItems.text })
    .from(fixListItems)
    .where(
      and(eq(fixListItems.trackId, session.trackId), inProbe(fixListItems.createdAt, session.id)),
    )
    .orderBy(asc(fixListItems.createdAt), asc(fixListItems.id));
  const latest = new Map<string, TrackTerm>();
  for (const row of events) latest.set(row.term.toLowerCase(), row);
  const section = (heading: string, lines: string[]) =>
    lines.length ? [{ heading, body: lines.join("\n") }] : [];
  return {
    sections: [
      ...section(
        "What the probe recorded about the learner's terms",
        events.map((r) => `- ${r.term}: ${r.status} (${r.evidence})`),
      ),
      ...section(
        "Misconceptions the probe noted",
        misconceptions.map((m) => `- ${m.text}`),
      ),
    ],
    // Held as the probe left them: what the verdict may name as the learner's.
    held: [...latest.values()].filter((t) => HELD.has(t.status)),
  };
}

export interface ProbeVerdictDependencies {
  db: Db;
  models: ModelAccess;
  method: Method;
}

/** The verdict's job: written once the learner asks, the session going on regardless. */
export function createProbeVerdictTasks(deps: ProbeVerdictDependencies): TaskList {
  const { db, models, method } = deps;

  const write = async (session: Session): Promise<ProbeVerdict> => {
    const [track] = await db.select().from(tracks).where(eq(tracks.id, session.trackId));
    if (!track) throw new Error(`no track ${session.trackId}`);
    const history = probePart(
      await db
        .select()
        .from(sessionMessages)
        .where(eq(sessionMessages.sessionId, session.id))
        .orderBy(asc(sessionMessages.createdAt), asc(sessionMessages.id)),
    );
    const records = await probeRecords(db, session);
    const files = await trackFileRows(db, session.trackId);
    // The probe's own phase: its method holds here too (a probe teaches nothing).
    const system = systemMessages(
      assembleSystemPrompt(method, "probe", {
        track: { title: track.title, language: track.language },
        ...(files.length
          ? { brought: { files: files.map((f) => f.name), summary: track.brief } }
          : {}),
        extra: [
          ...records.sections,
          ...(session.probeSummary
            ? [{ heading: "What the probe found, for the plan", body: session.probeSummary }]
            : []),
        ],
      }),
    );
    const opening = `(The learner started a session. They said they want to learn: ${track.goal})`;
    const asking: ModelMessage[] = [
      {
        role: "user",
        content: files.length ? `${opening}\n\n${filesLine(files.map((f) => f.name))}` : opening,
      },
      ...conversationFor(history, null),
      { role: "user", content: PROBE_VERDICT_PROMPT },
    ];
    const model = await models.model({
      userId: session.userId,
      trackId: session.trackId,
      sessionId: session.id,
      purpose: "probe-verdict",
      role: "strong",
    });
    // Traced, so each attempt's verdict is stored on its call (call-trace.ts).
    const call = (messages: ModelMessage[]) =>
      traced(async () => {
        const { output } = await generateText({
          model,
          system,
          output: Output.object({ schema: probeVerdictSchema }),
          messages,
        });
        return output;
      });

    // Checked as a chat message is (design §3.3): the exact rules, then the wording review; one
    // rewrite fixes both, and a rewrite that still breaks one is kept, as a chat message's is.
    const review = createReviewer(db, models, {
      userId: session.userId,
      trackId: session.trackId,
      sessionId: session.id,
    });
    const issuesOf = async (verdict: ProbeVerdict): Promise<Issue[]> => {
      const text = verdictText(verdict);
      const { errors, flagged } = chatIssues(text, "chat", records.held);
      return [
        ...errors,
        ...(await review({ markdown: text, flagged, terms: records.held, introduced: [] })),
      ];
    };
    const draft = await call(asking);
    const verdict = draft.value;
    const issues = await issuesOf(verdict);
    await draft.judge({ rewrite: 0, issues: verdictIssues(issues) });
    if (issues.length === 0) return verdict;
    log.info(
      {
        issues: issues.map((i) => i.code),
        ...content({ issues: issues.map((i) => i.message) }),
      },
      "verdict broke rules; rewriting it",
    );
    const rewrite = await call([
      ...asking,
      { role: "assistant", content: JSON.stringify(verdict) },
      {
        role: "user",
        content: `Write it again; it broke these rules:\n${issues.map((i) => `- ${i.message}`).join("\n")}`,
      },
    ]);
    const still = chatIssues(verdictText(rewrite.value), "chat", records.held).errors;
    await rewrite.judge({ rewrite: 1, issues: verdictIssues(still) });
    if (still.length > 0)
      log.warn(
        { issues: still.map((i) => i.code) },
        "rewritten verdict still breaks rules; keeping it",
      );
    return rewrite.value;
  };

  const probeVerdict: Task = async (payload) => {
    const { sessionId } = payload as { sessionId: string };
    const [session] = await db
      .select()
      .from(learningSessions)
      .where(eq(learningSessions.id, sessionId));
    if (!session) throw new Error(`no session ${sessionId}`);
    addLogContext({ userId: session.userId, trackId: session.trackId });
    // Only a verdict still asked for is written: recovery may have given up on it meanwhile.
    if (session.probeVerdictStatus !== "writing") return;
    const settle = (set: Partial<Session>) =>
      db
        .update(learningSessions)
        .set({ ...set, probeVerdictAt: new Date() })
        .where(
          and(
            eq(learningSessions.id, sessionId),
            eq(learningSessions.probeVerdictStatus, "writing"),
          ),
        );
    try {
      const verdict = await write(session);
      await settle({ probeVerdict: verdict, probeVerdictStatus: "written" });
    } catch (error) {
      // Otherwise the seam waits forever: say why, and let the learner ask again.
      const known = error instanceof ProviderCallError || error instanceof NoCredentialError;
      await settle({
        probeVerdictStatus: "failed",
        probeVerdictFailure: known ? error.message : WENT_WRONG,
      });
      await publishVerdict(db, sessionId);
      if (!known) throw error;
      reportHandledFailure(error);
      return;
    }
    await publishVerdict(db, sessionId);
  };

  return { "probe-verdict": probeVerdict };
}

/**
 * Verdicts a job that died left being written (design §4.2), in open sessions and closed ones
 * alike: the learner may ask long after the session closed. One no live job is working on and none
 * is queued for is marked failed, so the learner can ask again. Only one asked for more than
 * `quietForMs` ago is looked at: the request may be between marking it and queuing its job.
 */
export async function recoverVerdicts(db: Db, quietForMs: number): Promise<void> {
  const stuck = await db
    .select({ id: learningSessions.id })
    .from(learningSessions)
    .where(
      and(
        eq(learningSessions.probeVerdictStatus, "writing"),
        sql`${learningSessions.probeVerdictAt} < now() - make_interval(secs => ${quietForMs / 1000})`,
      ),
    );
  const failed: string[] = [];
  for (const { id } of stuck) {
    const marked = await unlessWorkedOn(db, id, async () => {
      if (await jobWaiting(db, "probe-verdict", id)) return false;
      const rows = await db
        .update(learningSessions)
        .set({
          probeVerdictStatus: "failed",
          probeVerdictFailure: INTERRUPTED,
          probeVerdictAt: new Date(),
        })
        .where(and(eq(learningSessions.id, id), eq(learningSessions.probeVerdictStatus, "writing")))
        .returning({ id: learningSessions.id });
      return rows.length > 0;
    });
    if (marked) failed.push(id);
  }
  for (const id of failed) await publishVerdict(db, id);
  if (failed.length) log.warn({ verdicts: failed.length }, "recovered verdicts a dead job left");
}

/** The track's first session's verdict, once written: the track page's "Where you started". */
export async function whereYouStarted(
  db: Db,
  trackId: string,
): Promise<{ sessionId: string; verdict: ProbeVerdict } | null> {
  const [first] = await db
    .select({ id: learningSessions.id, verdict: learningSessions.probeVerdict })
    .from(learningSessions)
    .where(eq(learningSessions.trackId, trackId))
    .orderBy(asc(learningSessions.createdAt), asc(learningSessions.id))
    .limit(1);
  return first?.verdict ? { sessionId: first.id, verdict: first.verdict } : null;
}
