import {
  allowedBlocksLine,
  assembleSystemPrompt,
  auditDecisionSchema,
  breakDemotions,
  checkVerdictIssues,
  checkVerdictSchema,
  generateLesson,
  LessonOutlineError,
  openingReviewDecisionSchema,
  planActionsSchema,
  probeDecisionSchema,
  placeChecks,
  sweepActionsSchema,
  teachBackDecisionSchema,
  trackActionsSchema,
  type AssignmentKind,
  type CheckVerdict,
  type Method,
  type OutlineProblem,
  type Phase,
  type PromptContext,
  type SessionState,
  type Cause,
  type FailureNotice,
} from "@grounded/core";
import { parseBlocks, validate, type TrackTerm } from "@grounded/content";
import {
  and,
  asc,
  checkMessages,
  eq,
  learningSessions,
  lessons,
  sessionMessages,
  sql,
  tracks,
  type Db,
} from "@grounded/db";
import { generateText, Output, type ModelMessage } from "ai";
import type { Task, TaskList } from "graphile-worker";
import { systemMessages } from "./call-options.js";
import { traced, verdictIssues } from "./call-trace.js";
import { ASKED_IN_THE_MARGIN, asidesRecord } from "./asides.js";
import {
  assignmentOf,
  assignmentSummary,
  createAssignment,
  OPEN_HOMEWORK,
  openHomeworkRecord,
  recordAssignment,
} from "./assignments.js";
import {
  arcsClosing,
  EXAM_ARCS,
  EXAM_RECORD_PROMPT,
  EXAM_REQUEST,
  examArcsRecord,
  markArcsClosed,
  OPEN_EXAM,
  openExamRecord,
} from "./arc-exams.js";
import { alreadyHeldSoFar, loadCheckRecord } from "./check-record.js";
import { writeChatMessage } from "./chat.js";
import {
  conversationFor,
  dueForSummary,
  summarizeEarlier,
  type EarlierSummary,
} from "./conversation.js";
import {
  briefTrack,
  broughtFiles,
  filesLine,
  isFirstSession,
  ORIGINALS_PHASES,
} from "./brought.js";
import { publish, startActivity, withActivity, type Activity, publishFailure } from "./events.js";
import {
  AUDIT_DECISION_PROMPT,
  auditOpening,
  FINAL_ANSWERS,
  FINAL_FOUND,
  FINAL_PART,
  FINAL_RECAP_REQUEST,
  FINAL_SWEEP_REQUEST,
  finalOutcome,
  finalRecord,
  recordBreaks,
  TEACH_BACK_DECISION_PROMPT,
  TEACH_BACK_OPENING_PROMPT,
} from "./final.js";
import {
  LEFT_OFF_CATCH_UP,
  LEFT_OFF_CATCH_UP_PROMPT,
  LEFT_OFF_PROMPT,
  writeLeftOff,
} from "./left-off.js";
import { type ModelAccess, causeOf } from "./model-call.js";
import type { FileStore } from "../files/store.js";
import { createLessonMedia } from "../media/lesson-media.js";
import { withVerifiedLinks, type VerifierOptions } from "../media/verify.js";
import { addLogContext, content, log } from "../log.js";
import { profileDue } from "./profile.js";
import { reportHandledFailure, type JobQueue } from "./queue.js";
import { plannedIn } from "../term-map.js";
import { applyEvent, completeIfDone, loadSession, RejectedEvent } from "./session-store.js";
import { HOMEWORK_REVIEWED, resolveLeaks, sessionReviewRecord } from "./reviews.js";
import {
  openingReviewRecord,
  REVIEW_FOUND,
  REVIEW_WAITING,
  reviewsUnderWay,
  takenUpBy,
} from "./opening-review.js";
import { recordEdits, rejectionIssues } from "./track-edits.js";
import { markCardsTaught } from "./word-cards.js";
import { createReviewer } from "./review.js";
import {
  LESSON_RESEARCH_PROMPT,
  PLAN_RESEARCH_PROMPT,
  research,
  sessionResearch,
  storeResearch,
} from "./research.js";
import {
  applyActions,
  applyValidActions,
  loadTrackContext,
  type TrackContext,
} from "./track-state.js";

export interface SessionTaskDependencies {
  db: Db;
  models: ModelAccess;
  method: Method;
  queue: JobQueue;
  /** Learners' files (design §4.5). */
  files: FileStore;
  /** Where lesson media is found and verified (design §6.4); tests pass a web of their own. */
  media: VerifierOptions;
}

interface SessionJob {
  sessionId: string;
  stepId?: string;
}

const PLAN_ATTEMPTS = 3;
const SWEEP_ATTEMPTS = 3;

/** The phases after the lesson, whose calls carry what happened at its checks. */
const AFTER_CHECKS_PHASES: readonly Phase[] = ["homework", "close"];

const PROBE_DECISION_PROMPT =
  "(For the app; the learner doesn't see this.) Record what the learner's answers so far showed that isn't recorded yet. Then say whether probing is finished: you know where the learner's knowledge ends and what they want to reach, well enough to plan against, or they asked to move on to the plan. It isn't finished while a strand the goal needs has a floor and no ceiling: an answer they got right only says where they stand from below, so the next question goes sharply harder. A cold start is the exception (everything missed, the easy questions too). If it is finished, you won't write another probe message: the plan comes next, in its own message.";
const PROBE_SUMMARY_PROMPT =
  "(For the app; the learner doesn't see this.) The probe is finished. Write what it found, for the plan: for each strand the goal needs (in a track's first session, each main area of it), what the learner holds and where it stops, in their own words where you can. Where you found where a strand stops but not what they hold below it, say so; that is not the same as holding nothing. Then what they want to reach. Plain prose, no preamble.";
const REVIEW_OPENING_PROMPT = `(For the app; the learner doesn't see this.) Before the probe, open the session with the review of what came up since the last one, under "${REVIEW_WAITING}", as the method's review says: the arc exam first. Say in a sentence what you'll look at, then ask the first question.`;
const REVIEW_DECISION_PROMPT = `(For the app; the learner doesn't see this.) Record what the learner's answers in the review showed that isn't recorded yet, and the labels of the leaks still open (under "${REVIEW_WAITING}") that they have now found. Then say whether the review is finished: every item there taken up, or they asked to move on. If it is, you won't write another review message: the probe comes next.`;
const REVIEW_SUMMARY_PROMPT =
  "(For the app; the learner doesn't see this.) The review is finished. Write what it found, for the probe and the plan. If it took up an arc exam, say first whether the arc held; if it didn't, what has to be re-taught before the next arc builds on it (the next arc waits). Then, for each item it took up, whether it held now or still leaks, and where, in the learner's words where you can. Plain prose, no preamble.";
/** The review hands over to the probe, whose opening question follows the review's last answer. */
const REVIEW_HANDOVER_PROMPT = `(For the app; the learner doesn't see this.) The review is over; what it found is under "${REVIEW_FOUND}". Now the probe: acknowledge their last answer in a few neutral words, then ask the first probe question.`;
/** The most answers a review takes: a few questions, not a quiz (method.md, "Review"). */
const REVIEW_ANSWERS = 5;
const PLAN_RECORD_PROMPT =
  "(For the app; the learner doesn't see this.) Record the plan you just presented: every planned term with what it rests on (a term already in the term list, shown here or not, keeps its status; planning it again only adds what it rests on), and any misconceptions found in the probe as fix-list items. A word the plan leans on that the learner already holds (plain everyday language in its everyday sense, or a term they used themselves as the field does) is recorded assumed with set-term-status, with their words or its everyday use as evidence, instead of planned; planned terms may rest on it. An idea the plan leans on that the learner holds in another track (under \"Held in the learner's other tracks\", with the same meaning here) is borrowed with borrow-term instead of planned; planned terms may rest on it. Then place this session's new planned terms in the plan's arcs with add-to-arc: each in the existing arc it belongs to, named by that arc's exact title as the plan shows it; a new arc (added at the end) only for terms no existing arc fits. This doesn't change the rest of the plan: its other arcs and terms stay as they are. If the track has no arcs yet, name the first ones. Record anything you noted for later sessions (a reorder, a detour, what to come back to) with add-plan-notes.";
const SWEEP_REQUEST =
  "settle every term's status from the whole session's evidence, and record any change to the plan or the fix-list. Change the plan's notes a section at a time with edit-plan-notes: the section's heading line as the notes write it, and its new text (null removes the section; a heading no section has adds one at the end). Fold what was \"Noted while planning\" into the sections it belongs to, then remove that section. Change the arcs with set-plan, notes null to keep the notes as they are.";
const HOMEWORK_REQUEST = `(The lesson's checks are done. Assign the homework: one task, of one kind: predict → verify, a derivation, a build, or explain it to a friend. Write the task itself, as the learner will read it on a page of its own: everything it needs restated in full, and for predict → verify what to predict and how to check it. The app gives the task the answer boxes of its kind (predict → verify: the prediction, locked before they check; what actually happened; reconcile. A derivation: its steps, each with its because. A build: what they made, and what surprised them. Explain it to a friend: one box), so don't write blanks or headings for the answers. What a good answer demonstrates is recorded next and shown with the task by the app; don't list it here. ${allowedBlocksLine("homework", "the homework", ["image", "audio"])} (Images and audio need the lesson's tools, which this call doesn't have.) A video or a link card only to a source from this session's research or lesson; the app checks each one opens and leaves out what doesn't.)`;
const HOMEWORK_RECORD_PROMPT =
  "(For the app; the learner doesn't see this.) Record the homework you just wrote: the kind of its task, a few words naming it, and what a good answer demonstrates.";

/**
 * An outline's problems for the log: how many, of which kinds, at which steps. Their messages quote
 * term names, so they are logged only with LOG_CONTENT.
 */
function outlineProblemFields(problems: readonly OutlineProblem[]) {
  const codes: Record<string, number> = {};
  for (const { code } of problems) codes[code] = (codes[code] ?? 0) + 1;
  return {
    problems: problems.length,
    codes,
    steps: [...new Set(problems.map((p) => p.step))],
    ...content({ reasons: problems.map((p) => p.message) }),
  };
}

/**
 * The app's reply when an answer couldn't be checked, so the learner can answer again: a notice the
 * web words (design §9.3), and the same in English for the tutor's later calls.
 */
export const checkFailed = (cause: Cause | null) => ({
  text: "That didn't go through. Answer again when you're ready.",
  failure: { code: "thread-failed", thread: "check", cause } satisfies FailureNotice,
});

/**
 * Adds a tutor message to a step's check thread and publishes it; a model's reply has its links
 * verified first (`media`), the app's own text needs none.
 */
export async function recordCheckMessage(
  db: Db,
  sessionId: string,
  stepId: string,
  text: string,
  verdict: "landed" | "missed" | null,
  media?: VerifierOptions,
  failure: FailureNotice | null = null,
): Promise<void> {
  const parsed = parseBlocks(text).blocks;
  const blocks = media ? await withVerifiedLinks(parsed, media) : parsed;
  const [row] = await db
    .insert(checkMessages)
    .values({ sessionId, stepId, role: "tutor", text, blocks, verdict, failure })
    .returning();
  if (!row) throw new Error("check message insert returned nothing");
  await publish(db, sessionId, "check-message", {
    id: row.id,
    stepId,
    role: "tutor",
    blocks,
    verdict,
    failure,
  });
}

/** The session's jobs. A failure the learner can act on is published as an error event. */
export function createSessionTasks(deps: SessionTaskDependencies): TaskList {
  const { db, models, method, queue, files } = deps;
  /** A phase's system prompt, in the parts that let the provider cache its stable start. */
  const systemFor = (phase: Phase, context: PromptContext) =>
    systemMessages(assembleSystemPrompt(method, phase, context));
  /** The review of what the validators can't match (review.ts), in a session's calls. */
  const reviewerFor = (session: { id: string; userId: string; trackId: string }) =>
    createReviewer(db, models, {
      userId: session.userId,
      trackId: session.trackId,
      sessionId: session.id,
    });

  const contextFor = async (
    sessionId: string,
    phase: Phase,
    /** What this call carries besides its phase's (the arcs an exam covers). */
    more: readonly { heading: string; body: string }[] = [],
    /**
     * What of the track it leaves out or adds: the final's audit leaves out the fix-list kept
     * before it, and the final's close reads the plan's notes as written.
     */
    view: { fixList?: false; notes?: true } = {},
  ) => {
    const session = await loadSession(db, sessionId);
    const whole = await loadTrackContext(db, session.trackId, {
      sessionId,
      phase,
      ...(view.notes ? { notes: true } : {}),
    });
    // What the session added to the fix-list is still shown, among its changes.
    const loaded = view.fixList === false ? { ...whole, fixList: [] } : whole;
    // The first session's probe and plan read the files themselves, in the opening turn; every
    // other call carries what the learner brought, summarized (design §4.5).
    const originals =
      loaded.brought &&
      ORIGINALS_PHASES.includes(phase) &&
      (await isFirstSession(db, sessionId, session.trackId))
        ? await broughtFiles(db, files, session.trackId)
        : null;
    const brought = originals ? withoutBrought(loaded) : loaded;
    // The calls after the lesson hear what happened at its checks: the answers, what leaked, and what
    // the learner showed they already held.
    const after = AFTER_CHECKS_PHASES.includes(phase);
    const checks = after ? await loadCheckRecord(db, sessionId, session.state) : null;
    // And the questions asked in the margin, which the close carries on to the next session.
    const asked = after ? await asidesRecord(db, sessionId) : null;
    // The homework hears the track's homework still open, which it subsumes (method.md, "Homework").
    const putOff =
      phase === "homework" ? await openHomeworkRecord(db, session.trackId, sessionId) : null;
    // The close hears the review of the homework handed in, which it waited for (design §7.4).
    const reviewed = phase === "close" ? await sessionReviewRecord(db, sessionId) : null;
    // The probe folds an arc exam still open into its questions (method.md, "The arc exam").
    const examOpen =
      phase === "probe" ? await openExamRecord(db, session.trackId, sessionId) : null;
    // The probe hears what the opening review found; the plan's call adds it itself.
    const found = phase === "probe" ? reviewFound(session) : [];
    const extra = [
      ...found,
      ...(checks ? [{ heading: "What happened at the lesson's checks", body: checks }] : []),
      ...(asked ? [{ heading: ASKED_IN_THE_MARGIN, body: asked }] : []),
      ...(reviewed ? [{ heading: HOMEWORK_REVIEWED, body: reviewed }] : []),
      ...(putOff ? [{ heading: OPEN_HOMEWORK, body: putOff }] : []),
      ...(examOpen ? [{ heading: OPEN_EXAM, body: examOpen }] : []),
      ...more,
    ];
    const track = extra.length ? { ...brought, extra } : brought;
    const terms: TrackTerm[] = track.current;
    const history = await db
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(asc(sessionMessages.createdAt), asc(sessionMessages.id));
    const system = systemFor(phase, track);
    // A long conversation's older turns are carried as a summary (conversation.ts).
    let summary: EarlierSummary | null =
      session.earlierSummary !== null && session.summarizedThrough !== null
        ? { text: session.earlierSummary, through: session.summarizedThrough }
        : null;
    const due = dueForSummary(history, summary);
    if (due.length > 0) {
      summary = await summarizeEarlier({
        db,
        sessionId,
        model: () =>
          models.model({
            userId: session.userId,
            trackId: session.trackId,
            sessionId: session.id,
            purpose: "conversation-summary",
            role: "strong",
          }),
        system,
        summary,
        turns: due,
      });
    }
    const messages = conversationFor(history, summary);
    // A conversation starts with the learner; the app opens it on their behalf, with what they said
    // they want to learn (their words as typed) and any files they read here, so the first question
    // builds on them.
    if (messages[0]?.role !== "user") {
      const opening = `(The learner started a session. They said they want to learn: ${track.goal})`;
      messages.unshift({
        role: "user",
        content: originals
          ? [
              { type: "text", text: `${opening}\n\n${filesLine(originals.names)}` },
              ...originals.parts,
            ]
          : opening,
      });
    }
    // The review's answers are their own kind: the probe's opening question follows them.
    const answered = (kind: "review" | "message" | "audit" | "teach-back") =>
      history.filter((m) => m.role === "learner" && m.kind === kind).length;
    return { session, track, terms, messages, answered, history, system };
  };

  /** The session's homework or recap, if it has been written. */
  const writtenMessage = async (sessionId: string, kind: "homework" | "exam" | "recap") => {
    const [row] = await db
      .select({
        id: sessionMessages.id,
        text: sessionMessages.text,
        blocks: sessionMessages.blocks,
      })
      .from(sessionMessages)
      .where(and(eq(sessionMessages.sessionId, sessionId), eq(sessionMessages.kind, kind)))
      .limit(1);
    return row ? { id: row.id, text: row.text ?? "", blocks: row.blocks ?? [] } : null;
  };

  /**
   * The close's context and its recap's request. A final's is its own phase's, with what its
   * review and the final itself found, and the plan's notes as written, which its sweep edits.
   */
  const closeContext = async (sessionId: string) => {
    const session = await loadSession(db, sessionId);
    if (session.state.kind !== "final")
      return {
        final: false,
        request: "(Close the session: the recap.)",
        context: await contextFor(sessionId, "close"),
      };
    const found = { heading: FINAL_FOUND, body: finalRecord(await finalOutcome(db, session)) };
    return {
      final: true,
      request: FINAL_RECAP_REQUEST,
      context: await contextFor(sessionId, "final", [...reviewFound(session), found], {
        notes: true,
      }),
    };
  };

  /**
   * An assignment written as a chat message the learner watches, then recorded (its tasks' kinds,
   * a name, what a good answer demonstrates) and kept as an assignment of its own (design §7.4).
   * A message already written stands: the record goes on from it.
   */
  const writeAssignment = async (
    sessionId: string,
    kind: AssignmentKind,
    request: string,
    recordPrompt: string,
    more: readonly { heading: string; body: string }[] = [],
  ) => {
    const context = await contextFor(sessionId, "homework", more);
    const { session, terms, system } = context;
    const model = await models.model({
      userId: session.userId,
      trackId: session.trackId,
      sessionId: session.id,
      purpose: kind,
      role: "strong",
    });
    const written = await writtenMessage(sessionId, kind);
    // The message is the conversation's last turn once written.
    const messages = written ? context.messages.slice(0, -1) : context.messages;
    const asking: ModelMessage[] = [...messages, { role: "user", content: request }];
    let message = written;
    if (!message) {
      const reply = await writeChatMessage({
        db,
        media: deps.media,
        review: reviewerFor(session),
        sessionId,
        model,
        system,
        messages: asking,
        terms,
        kind,
        surface: "homework",
      });
      message = { id: reply.messageId, text: reply.text, blocks: reply.blocks };
    }
    const record = await withActivity(db, sessionId, { code: "noting-good-answer" }, () =>
      recordAssignment({
        model,
        system,
        messages: [...asking, { role: "assistant", content: message.text }],
        request: recordPrompt,
        terms,
      }),
    );
    await createAssignment(db, { session, kind, message, record });
  };

  const lessonRow = async (sessionId: string) => {
    const [row] = await db.select().from(lessons).where(eq(lessons.sessionId, sessionId));
    if (!row) throw new Error(`no lesson for session ${sessionId}`);
    return row;
  };

  const threadsOf = (sessionId: string) =>
    db
      .select()
      .from(checkMessages)
      .where(eq(checkMessages.sessionId, sessionId))
      .orderBy(asc(checkMessages.createdAt), asc(checkMessages.id));

  /** The prompt for grading or re-asking a step: the check phase's method plus the step and its thread. */
  const checkPrompt = async (sessionId: string, stepId: string, state: SessionState) => {
    const session = await loadSession(db, sessionId);
    const track = await loadTrackContext(db, session.trackId, { sessionId, phase: "check" });
    const lesson = await lessonRow(sessionId);
    const thread = (await threadsOf(sessionId)).filter((m) => m.stepId === stepId);
    const held = alreadyHeldSoFar(
      Object.fromEntries(Object.entries(lesson.alreadyHeld).filter(([id]) => id !== stepId)),
    );
    const index = state.lesson.steps.findIndex((s) => s.id === stepId);
    const placed = state.lesson.steps[index]?.check;
    // A check covers every step whose ideas it asks about, not only the one it ends.
    const covered = placed?.steps ?? [stepId];
    const misses = state.steps[stepId]?.misses ?? 0;
    const introduced = (lesson.outline?.steps ?? [])
      .slice(0, index + 1)
      .flatMap((s) => s.introduces);
    // Where the learner asked about these steps in the margin, the steps were unclear to them.
    const asked = await asidesRecord(db, sessionId, covered);
    const system = systemFor("check", {
      ...track,
      extra: [
        {
          heading:
            covered.length > 1
              ? `The steps this check covers (it ends step ${stepId.slice(1)})`
              : "The step being checked",
          body: covered.map((id) => lesson.stepSources[id] ?? "").join("\n\n"),
        },
        {
          heading: "Its check thread so far",
          body:
            thread
              .map((m) => `${m.role === "learner" ? "Learner" : "Tutor"}: ${m.text ?? ""}`)
              .join("\n") || "(none)",
        },
        ...(held
          ? [
              {
                heading: "What the learner showed they already held, earlier in this lesson",
                body: held,
              },
            ]
          : []),
        ...(asked ? [{ heading: ASKED_IN_THE_MARGIN, body: asked }] : []),
        {
          heading: "Where this step stands",
          body: [
            `Missed answers on this step so far: ${String(misses)}.`,
            placed?.terms.length ? `This check covers: ${placed.terms.join(", ")}.` : "",
            placed?.gates
              ? "The next step rests on what this check covers."
              : index === state.lesson.steps.length - 1
                ? "This is the lesson's last check; the homework comes next."
                : "Nothing ahead in the lesson rests on it.",
            misses >= 1
              ? "If this answer misses too, the idea is still settling: say so kindly, stop repairing, and give no fresh question."
              : "If this answer misses, repair the piece that leaked, rebuilt from what it rests on, and give a fresh question on the same ideas.",
          ]
            .filter(Boolean)
            .join(" "),
        },
      ],
    });
    const terms: TrackTerm[] = track.current;
    return { session, system, thread, terms, introduced };
  };

  /**
   * However writing a lesson fails (the provider, a missing key, anything else), its job marks it
   * failed before the learner is told why. A lesson left unfinished is then always one whose job died,
   * so recovery (recovery.ts) never reports a failed lesson a second time.
   */
  const markLessonFailed = async ({ sessionId }: SessionJob) => {
    try {
      await applyEvent(db, sessionId, { type: "lesson-failed" });
    } catch (rejected) {
      // No lesson is being written, so there is nothing to mark.
      if (!(rejected instanceof RejectedEvent)) throw rejected;
    }
  };

  /**
   * Writes "where you left off" for plan notes too long to carry that have none yet (an imported
   * track). Returns whether it did; if the call fails, the notes are carried as written until the
   * close writes one.
   */
  const catchUpLeftOff = async (session: { id: string; userId: string; trackId: string }) => {
    const [track] = await db
      .select({ leftOff: tracks.leftOff, plan: tracks.plan })
      .from(tracks)
      .where(eq(tracks.id, session.trackId));
    if (track?.leftOff !== null || track.plan.notes.length <= LEFT_OFF_CATCH_UP) return false;
    try {
      const whole = await loadTrackContext(db, session.trackId, {
        sessionId: session.id,
        phase: "close",
      });
      await writeLeftOff({
        db,
        sessionId: session.id,
        trackId: session.trackId,
        model: await models.model({
          userId: session.userId,
          trackId: session.trackId,
          sessionId: session.id,
          purpose: "left-off",
          role: "strong",
        }),
        system: systemFor("close", whole),
        messages: [{ role: "user", content: LEFT_OFF_CATCH_UP_PROMPT }],
        label: { code: "reading-left-off" },
      });
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Writes "what you brought" before a later session's opening question, for a track with files and
   * none yet (the job at the track's creation failed). The first session reads the files themselves.
   * Returns whether it did; if the call fails, the session carries the files' names only.
   */
  const catchUpBrief = async (session: { id: string; trackId: string }) => {
    const [track] = await db
      .select({ brief: tracks.brief })
      .from(tracks)
      .where(eq(tracks.id, session.trackId));
    if (track?.brief !== null || (await isFirstSession(db, session.id, session.trackId)))
      return false;
    try {
      const brief = await withActivity(db, session.id, { code: "reading-brought" }, () =>
        briefTrack({ db, store: files, models, trackId: session.trackId }),
      );
      return brief !== null;
    } catch {
      return false;
    }
  };

  /** Runs a job; `onFailure` settles what it leaves behind before the error is reported. */
  const guarded =
    (
      run: (job: SessionJob) => Promise<void>,
      onFailure?: (job: SessionJob) => Promise<void>,
    ): Task =>
    async (payload) => {
      const job = payload as SessionJob;
      try {
        const { userId, trackId } = await loadSession(db, job.sessionId);
        addLogContext({ userId, trackId });
        await run(job);
      } catch (error) {
        await onFailure?.(job);
        if (error instanceof LessonOutlineError)
          log.warn(
            outlineProblemFields(error.problems),
            "lesson outline didn't fit the term list in any attempt",
          );
        const cause = causeOf(error);
        const known = cause !== null || error instanceof LessonOutlineError;
        await publishFailure(
          db,
          job.sessionId,
          error instanceof LessonOutlineError
            ? { code: "outline-failed" }
            : (cause ?? { code: "our-side" }),
        );
        if (!known) throw error;
        reportHandledFailure(error);
      }
    };

  return {
    // The review that opens a session (design §7.1), a conversation shaped like the probe's:
    // after each answer a structured call records what it showed and whether the review is done,
    // and only then is the next message written. Done, what it found is written once, for the
    // probe and the plan, and the probe's opening question follows.
    "opening-review": guarded(async ({ sessionId }) => {
      const session = await loadSession(db, sessionId);
      if (session.state.phase !== "review") return;
      // A review it took up is still being written: that review's end queues this job again.
      if (await reviewsUnderWay(db, sessionId)) return;
      // On to the probe, or in the final its audit.
      const onTo = async () => {
        const next = await applyEvent(db, sessionId, { type: "review-done" });
        await queue.enqueue(next.phase === "audit" ? "final-turn" : "probe-turn", { sessionId });
      };
      // What waits, labelled as the call reads it, and the call's context with it.
      const load = async () => {
        const waiting = await openingReviewRecord(db, session);
        const context = await contextFor(sessionId, "review", [
          {
            heading: REVIEW_WAITING,
            body: waiting?.text ?? "Nothing is left open: the learner has taken it all up since.",
          },
        ]);
        return { waiting, context };
      };
      let { waiting, context } = await load();
      // Already answered: the job was queued twice (the review's end, and "Try again").
      if (context.history.at(-1)?.role === "tutor") return;
      const answers = context.answered("review");
      // Nothing left to take up before a word was said (every flaw found in the margin meanwhile,
      // say): the probe, without a call.
      if (!waiting && answers === 0) return onTo();
      const modelFor = (purpose: string) =>
        models.model({
          userId: session.userId,
          trackId: session.trackId,
          sessionId: session.id,
          purpose,
          role: "strong",
        });

      if (answers > 0) {
        const decider = await modelFor("opening-review-decision");
        const asking: ModelMessage[] = [
          ...context.messages,
          { role: "user", content: REVIEW_DECISION_PROMPT },
        ];
        const decided = await traced(() =>
          withActivity(db, sessionId, { code: "noting-answers" }, () =>
            generateText({
              model: decider,
              system: context.system,
              output: Output.object({ schema: openingReviewDecisionSchema }),
              messages: asking,
            }),
          ),
        );
        const { output } = decided.value;
        if (output.actions.length)
          await recordEdits(db, {
            sessionId,
            trackId: session.trackId,
            actions: output.actions,
            source: "review",
            label: { code: "noting-answers" },
            judge: decided.judge,
            askAgain: async (feedback) =>
              (
                await generateText({
                  model: decider,
                  system: context.system,
                  output: Output.object({ schema: trackActionsSchema }),
                  messages: [
                    ...asking,
                    { role: "assistant", content: JSON.stringify(output) },
                    { role: "user", content: feedback },
                  ],
                })
              ).output.actions,
          });
        // The leaks they found in the chat, as the margin's card would have resolved them.
        const found = output.resolved.flatMap((label) => {
          const id = waiting?.labels.get(label.trim());
          return id ? [id] : [];
        });
        await resolveLeaks(db, found, sessionId);
        if (output.finished || !waiting || answers >= REVIEW_ANSWERS) {
          const summarizer = await modelFor("opening-review-summary");
          const { text: summary } = await withActivity(
            db,
            sessionId,
            { code: "taking-stock" },
            () =>
              generateText({
                model: summarizer,
                system: context.system,
                messages: [...context.messages, { role: "user", content: REVIEW_SUMMARY_PROMPT }],
              }),
          );
          await db
            .update(learningSessions)
            .set({ reviewSummary: summary.trim() || null })
            .where(eq(learningSessions.id, sessionId));
          return onTo();
        }
        // The next question is written with what was just recorded.
        if (output.actions.length || found.length) ({ waiting, context } = await load());
      } else {
        // The chat links the work it takes up, whose reviews may have finished since the page
        // was opened.
        await publish(db, sessionId, "taken-up", {
          assignments: (await takenUpBy(db, sessionId)).map(assignmentSummary),
        });
      }
      await writeChatMessage({
        db,
        media: deps.media,
        review: reviewerFor(session),
        sessionId,
        model: await modelFor("opening-review"),
        system: context.system,
        messages:
          answers === 0
            ? [...context.messages, { role: "user", content: REVIEW_OPENING_PROMPT }]
            : context.messages,
        terms: context.terms,
        kind: "review",
      });
    }),

    // Decide first, then write: a turn that finishes the probe writes no probe message, so a model
    // that feels done can't present the plan there; the plan job is the only place a plan appears.
    "probe-turn": guarded(async ({ sessionId }) => {
      let context = await contextFor(sessionId, "probe");
      const { session } = context;
      const answered = context.answered("message");
      // Before the opening question, once: long notes with no summary yet get one (an import), and
      // files with no summary yet get one.
      if (!answered) {
        const leftOff = await catchUpLeftOff(session);
        const brief = await catchUpBrief(session);
        if (leftOff || brief) context = await contextFor(sessionId, "probe");
      }
      const modelFor = (purpose: "probe" | "probe-decision" | "probe-summary") =>
        models.model({
          userId: session.userId,
          trackId: session.trackId,
          sessionId: session.id,
          purpose,
          role: "strong",
        });
      // The opening question follows nothing the learner said in the probe: nothing to record,
      // nothing decided.
      if (answered) {
        // Its own purpose: a small structured record, made with little reasoning (call-options.ts).
        const decider = await modelFor("probe-decision");
        const decided = await traced(() =>
          withActivity(db, sessionId, { code: "noting-answers" }, () =>
            generateText({
              model: decider,
              system: context.system,
              output: Output.object({ schema: probeDecisionSchema }),
              messages: [...context.messages, { role: "user", content: PROBE_DECISION_PROMPT }],
            }),
          ),
        );
        const { output } = decided.value;
        if (output.actions.length) {
          await recordEdits(db, {
            sessionId,
            trackId: session.trackId,
            actions: output.actions,
            source: "probe",
            label: { code: "noting-answers" },
            judge: decided.judge,
            askAgain: async (feedback) =>
              (
                await generateText({
                  model: decider,
                  system: context.system,
                  output: Output.object({ schema: trackActionsSchema }),
                  messages: [
                    ...context.messages,
                    { role: "user", content: PROBE_DECISION_PROMPT },
                    { role: "assistant", content: JSON.stringify(output) },
                    { role: "user", content: feedback },
                  ],
                })
              ).output.actions,
          });
          // The question is written with what was just recorded (the teaching language, the fix-list).
          context = await contextFor(sessionId, "probe");
        }
        if (output.finished) {
          // What the plan is built on, so it thinks at the default effort: its own call, once.
          const summarizer = await modelFor("probe-summary");
          const { text: summary } = await withActivity(
            db,
            sessionId,
            { code: "finding-where-knowledge-ends" },
            () =>
              generateText({
                model: summarizer,
                system: context.system,
                messages: [...context.messages, { role: "user", content: PROBE_SUMMARY_PROMPT }],
              }),
          );
          await db
            .update(learningSessions)
            .set({ probeSummary: summary.trim() || null })
            .where(eq(learningSessions.id, sessionId));
          await applyEvent(db, sessionId, { type: "probe-done" });
          await queue.enqueue("plan", { sessionId });
          return;
        }
      }
      await writeChatMessage({
        db,
        media: deps.media,
        review: reviewerFor(session),
        sessionId,
        model: await modelFor("probe"),
        system: context.system,
        // After a review, the opening question follows its last answer.
        messages:
          !answered && context.answered("review")
            ? [...context.messages, { role: "user", content: REVIEW_HANDOVER_PROMPT }]
            : context.messages,
        terms: context.terms,
        kind: "message",
      });
    }),

    // The final's two parts (design §7.4), each a conversation shaped like the probe's: after each
    // answer a structured call records what it showed (the audit's misconceptions are the new
    // fix-list, the teach-back's breaks take their terms back to taught) and whether the part is
    // done. The audit hands over to the teach-back, and the teach-back to the close.
    "final-turn": guarded(async ({ sessionId }) => {
      const { state } = await loadSession(db, sessionId);
      const part = state.phase;
      if (part !== "audit" && part !== "teach-back") return;
      const audit = part === "audit";
      const load = () =>
        contextFor(sessionId, "final", [FINAL_PART[part]], audit ? { fixList: false } : {});
      let context = await load();
      const { session } = context;
      // Already answered: the job was queued twice ("Try again" as it started, say).
      if (context.history.at(-1)?.role === "tutor") return;
      const answers = context.answered(part);
      const modelFor = (purpose: string) =>
        models.model({
          userId: session.userId,
          trackId: session.trackId,
          sessionId: session.id,
          purpose,
          role: "strong",
        });

      if (answers > 0) {
        const decider = await modelFor(`${part}-decision`);
        const asking: ModelMessage[] = [
          ...context.messages,
          { role: "user", content: audit ? AUDIT_DECISION_PROMPT : TEACH_BACK_DECISION_PROMPT },
        ];
        const decide = () =>
          audit
            ? generateText({
                model: decider,
                system: context.system,
                output: Output.object({ schema: auditDecisionSchema }),
                messages: asking,
              }).then(({ output }) => ({ ...output, breaks: [] }))
            : generateText({
                model: decider,
                system: context.system,
                output: Output.object({ schema: teachBackDecisionSchema }),
                messages: asking,
              }).then(({ output }) => output);
        const decided = await traced(() =>
          withActivity(db, sessionId, { code: "noting-answers" }, decide),
        );
        const output = decided.value;
        // A break takes its term back to taught, the app's to derive (final.ts in core).
        const actions = [...output.actions, ...breakDemotions(output.breaks, context.terms)];
        if (actions.length)
          await recordEdits(db, {
            sessionId,
            trackId: session.trackId,
            actions,
            source: part,
            label: { code: "noting-answers" },
            judge: decided.judge,
            askAgain: async (feedback) =>
              (
                await generateText({
                  model: decider,
                  system: context.system,
                  output: Output.object({ schema: trackActionsSchema }),
                  messages: [
                    ...asking,
                    { role: "assistant", content: JSON.stringify(output) },
                    { role: "user", content: feedback },
                  ],
                })
              ).output.actions,
          });
        await recordBreaks(db, sessionId, output.breaks);
        if (output.finished || answers >= FINAL_ANSWERS[part]) {
          await applyEvent(db, sessionId, { type: audit ? "audit-done" : "teach-back-done" });
          await queue.enqueue(audit ? "final-turn" : "recap", { sessionId });
          return;
        }
        // The next question is written with what was just recorded.
        if (actions.length) context = await load();
      }
      // A part's first message opens it: the audit's the final (after the review's last answer,
      // if there was one), the teach-back's after the audit's.
      const opening =
        answers === 0
          ? audit
            ? auditOpening(context.answered("review") > 0)
            : TEACH_BACK_OPENING_PROMPT
          : null;
      await writeChatMessage({
        db,
        media: deps.media,
        review: reviewerFor(session),
        sessionId,
        model: await modelFor(part),
        system: context.system,
        messages: opening
          ? [...context.messages, { role: "user", content: opening }]
          : context.messages,
        terms: context.terms,
        kind: part,
      });
    }),

    lesson: guarded(async ({ sessionId }) => {
      const { session, terms, messages, system } = await contextFor(sessionId, "lesson");
      await db.insert(lessons).values({ sessionId }).onConflictDoNothing();
      // A failed lesson written again from where it stopped keeps its outline and the steps written
      // before it (lesson-again.ts); one written from the start has no outline yet.
      const row = await lessonRow(sessionId);
      const resume =
        row.outline && session.state.lesson.status === "ready"
          ? { outline: row.outline, written: row.steps.map((s) => row.stepSources[s.id] ?? "") }
          : undefined;
      const transcript = messages
        .map(
          (m) =>
            `${m.role === "user" ? "Learner" : "Tutor"}: ${typeof m.content === "string" ? m.content : ""}`,
        )
        .join("\n\n");
      const model = await models.model({
        userId: session.userId,
        trackId: session.trackId,
        sessionId: session.id,
        purpose: "lesson",
        role: "strong",
      });
      // Before an outline, what the lesson will state and the tutor isn't sure of is checked on the
      // web (design §7.2): a call of its own, which searches only where it needs to. It is
      // best-effort: without it, the lesson is written as it was before.
      const search = resume ? undefined : await models.searchTool(session.userId);
      if (search) {
        try {
          const found = await research({
            db,
            sessionId,
            model: await models.model({
              userId: session.userId,
              trackId: session.trackId,
              sessionId: session.id,
              purpose: "lesson",
              role: "strong",
            }),
            system,
            messages,
            search,
            request: LESSON_RESEARCH_PROMPT,
            label: { code: "checking-facts" },
          });
          log.info({ searches: found.searches.length }, "lesson research done");
          await storeResearch(db, { trackId: session.trackId, sessionId }, "lesson", found);
        } catch (error) {
          log.warn({ err: error }, "lesson research failed; outlining without it");
        }
      }
      // This session's research, the plan's included, for the outline and the writing (and for a
      // lesson written again, which searches nothing).
      const researched = await sessionResearch(db, sessionId);
      const notes = researched
        ? `\n\nResearch notes from this session, with their sources (the learner hasn't seen them): state these facts as the sources do.\n\n${researched}`
        : "";
      const outlining = resume
        ? undefined
        : await startActivity(db, sessionId, { code: "outlining" });
      let writing: Activity | undefined;
      let totalSteps = resume?.outline.steps.length ?? 0;
      try {
        const result = await generateLesson({
          model,
          system,
          request: `Write the lesson for the approved plan. The session so far:\n\n${transcript}${notes}`,
          terms,
          review: reviewerFor(session),
          trace: traced,
          ...(resume ? { resume } : {}),
          media: createLessonMedia({
            ...deps.media,
            activity: (label, run) => withActivity(db, sessionId, label, run),
          }),
          onOutline: async (outline) => {
            await outlining?.done();
            totalSteps = outline.steps.length;
            await db.update(lessons).set({ outline }).where(eq(lessons.sessionId, sessionId));
            // The steps are known from the outline, so the learner can start while later ones are written.
            await applyEvent(db, sessionId, { type: "lesson-ready", steps: placeChecks(outline) });
            await publish(db, sessionId, "lesson-outline", { totalSteps: outline.steps.length });
          },
          onStep: async (step, markdown) => {
            await db
              .update(lessons)
              .set({
                steps: sql`${lessons.steps} || ${JSON.stringify([step])}::jsonb`,
                stepSources: sql`${lessons.stepSources} || ${JSON.stringify({ [step.id]: markdown })}::jsonb`,
              })
              .where(eq(lessons.sessionId, sessionId));
            // Its word cards mark their terms taught once the learner can read it: before the
            // learner sees it, so nothing read from the step finds its words still planned.
            await markCardsTaught(db, sessionId);
            await publish(db, sessionId, "lesson-step", { step });
          },
          onOutlineRejected: (attempt, problems) => {
            log.info(
              { attempt, ...outlineProblemFields(problems) },
              "lesson outline didn't fit the term list; asking again",
            );
          },
          onStepStart: async (index, attempt, issues) => {
            if (attempt > 0)
              log.info(
                { stepId: `s${String(index + 1)}`, attempt, issues: issues.map((i) => i.code) },
                "lesson step broke rules; rewriting it",
              );
            await writing?.done();
            writing = await startActivity(db, sessionId, {
              code: "writing-step",
              step: index + 1,
              of: Math.max(totalSteps, index + 1),
              again: attempt > 0,
            });
          },
        });
        for (const { stepId, issues } of result.degraded)
          log.info(
            { stepId, issues: issues.map((i) => i.code) },
            "lesson step kept without its broken parts",
          );
        for (const { stepId, issues } of result.failed)
          log.warn({ stepId, issues: issues.map((i) => i.code) }, "lesson step failed");
        if (result.failed.length > 0) {
          const failedSteps = result.failed.map(({ stepId, heading }) => ({ stepId, heading }));
          await db.update(lessons).set({ failedSteps }).where(eq(lessons.sessionId, sessionId));
          for (const failed of failedSteps)
            await publish(db, sessionId, "lesson-step-failed", failed);
          // The lesson can't go past a step that isn't there: it failed, and can be written again
          // from that step (lesson-again.ts).
          await applyEvent(db, sessionId, { type: "lesson-failed" });
        }
      } finally {
        await outlining?.done();
        await writing?.done();
      }
    }, markLessonFailed),

    check: guarded(async ({ sessionId, stepId }) => {
      if (!stepId) throw new Error("check job without a step");
      try {
        const { state } = await loadSession(db, sessionId);
        const { session, system, thread, terms, introduced } = await checkPrompt(
          sessionId,
          stepId,
          state,
        );
        // Only an answer still waiting is graded: recovery may have answered it already (recovery.ts).
        const answer = thread.at(-1);
        if (answer?.role !== "learner") return;
        const model = await models.model({
          userId: session.userId,
          trackId: session.trackId,
          sessionId: session.id,
          purpose: "check",
          role: "strong",
        });

        const request = (feedback: string) =>
          `The learner's answer to this step's check: ${answer.text ?? ""}${feedback}`;
        // Traced, so each grading's verdict is stored on its call (call-trace.ts).
        const grade = (feedback: string) =>
          traced(() =>
            withActivity(db, sessionId, { code: "checking-answer" }, async () => {
              const { output } = await generateText({
                model,
                system,
                output: Output.object({ schema: checkVerdictSchema }),
                prompt: request(feedback),
              });
              return output;
            }),
          );
        const review = reviewerFor(session);
        // The reply and the fresh question, checked by matching; and the verdict's shape: a repair
        // asks nothing when a fresh question follows it.
        const matched = (graded: CheckVerdict) => {
          const texts = [graded.reply, graded.freshQuestion ?? ""].filter(Boolean);
          const found = texts.flatMap((text) => {
            const parsed = parseBlocks(text);
            return [
              ...parsed.issues,
              ...validate(parsed.blocks, { surface: "repair", terms, introduced }),
            ];
          });
          return {
            texts,
            found,
            errors: [
              ...checkVerdictIssues(graded),
              ...found.filter((i) => i.severity !== "review"),
            ],
          };
        };
        // Then what matching can't decide, judged together by the review.
        const problems = async (graded: CheckVerdict) => {
          const { texts, found, errors } = matched(graded);
          return [
            ...errors,
            ...(await review({
              markdown: texts.join("\n\n"),
              flagged: found.filter((i) => i.severity === "review"),
              terms,
              introduced,
            })),
          ];
        };
        const first = await grade("");
        let verdict = first.value;
        let judge = first.judge;
        const issues = await problems(verdict);
        await judge({ rewrite: 0, issues: verdictIssues(issues) });
        if (issues.length > 0) {
          log.info({ issues: issues.map((i) => i.code) }, "check reply broke rules; grading again");
          const again = await grade(
            `\n\nYour last reply broke these rules; fix them:\n${issues.map((i) => `- ${i.message}`).join("\n")}`,
          );
          ({ value: verdict, judge } = again);
          // Kept whatever it holds, as before; its verdict is matching's alone (no second review).
          await judge({ rewrite: 1, issues: verdictIssues(matched(verdict).errors) });
        }

        const graded = verdict;
        if (graded.actions.length)
          await recordEdits(db, {
            sessionId,
            trackId: session.trackId,
            actions: graded.actions,
            source: `check ${stepId}`,
            label: { code: "checking-answer" },
            judge,
            askAgain: async (feedback) =>
              (
                await generateText({
                  model,
                  system,
                  output: Output.object({ schema: trackActionsSchema }),
                  messages: [
                    { role: "user", content: request("") },
                    { role: "assistant", content: JSON.stringify(graded) },
                    { role: "user", content: feedback },
                  ],
                })
              ).output.actions,
          });
        // The lesson was pitched below the learner here: kept for the calls after the lesson, and
        // countable (design §7.3).
        if (verdict.alreadyHeld) {
          log.info({ stepId }, "the learner already held what a check covered");
          await db
            .update(lessons)
            .set({
              alreadyHeld: sql`${lessons.alreadyHeld} || ${JSON.stringify({ [stepId]: verdict.alreadyHeld })}::jsonb`,
            })
            .where(eq(lessons.sessionId, sessionId));
        }
        const next = await applyEvent(db, sessionId, {
          type: "check-verdict",
          stepId,
          verdict: verdict.verdict,
        });
        await markCardsTaught(db, sessionId, next);
        // A miss still being repaired is one tutor turn, the repair then the fresh question; the
        // app, not the model, withholds the question when the learner is offered pause or continue
        // (design §7.3).
        const step = next.steps[stepId];
        const asking =
          verdict.verdict === "missed" && step?.status === "open" && !step.offerGate
            ? verdict.freshQuestion
            : null;
        await recordCheckMessage(
          db,
          sessionId,
          stepId,
          asking ? `${verdict.reply}\n\n${asking}` : verdict.reply,
          verdict.verdict,
          deps.media,
        );

        if (verdict.verdict === "missed") {
          if (verdict.note) {
            await db
              .update(lessons)
              .set({
                notes: sql`${lessons.notes} || ${JSON.stringify({ [stepId]: verdict.note })}::jsonb`,
              })
              .where(eq(lessons.sessionId, sessionId));
            await publish(db, sessionId, "note", { stepId, note: verdict.note });
          }
        }
        await completeIfDone(db, queue, sessionId, next);
      } catch (error) {
        // Otherwise the answer stays "being checked" forever: say so in the thread, so the learner
        // can answer again.
        const failed = checkFailed(causeOf(error));
        await recordCheckMessage(
          db,
          sessionId,
          stepId,
          failed.text,
          null,
          undefined,
          failed.failure,
        );
        throw error;
      }
    }),

    "fresh-question": guarded(async ({ sessionId, stepId }) => {
      if (!stepId) throw new Error("fresh-question job without a step");
      const { state } = await loadSession(db, sessionId);
      const { session, system } = await checkPrompt(sessionId, stepId, state);
      const model = await models.model({
        userId: session.userId,
        trackId: session.trackId,
        sessionId: session.id,
        purpose: "check",
        role: "strong",
      });
      const { text } = await withActivity(db, sessionId, { code: "writing-fresh-question" }, () =>
        generateText({
          model,
          system,
          prompt:
            "The learner paused on this step last time and is back. Ask one fresh check question on the same idea, answerable in one or two lines. Reply with the question only.",
        }),
      );
      await recordCheckMessage(db, sessionId, stepId, text, null, deps.media);
    }),

    // The homework is written as a chat message the learner watches, then recorded as an
    // assignment of its own (its kind and what a good answer demonstrates), which outlives the
    // session. The session then waits for the learner to hand it in or put it off (design §7.4).
    // A session that closes an arc then sets its arc exam the same way, over the whole arc; the
    // exam never holds the session.
    homework: guarded(async ({ sessionId }) => {
      // Tried again after it failed past a message or a record (retry.ts): what was written stands.
      if (!(await assignmentOf(db, sessionId, "homework")))
        await writeAssignment(sessionId, "homework", HOMEWORK_REQUEST, HOMEWORK_RECORD_PROMPT);
      const session = await loadSession(db, sessionId);
      const closing = await arcsClosing(db, session);
      if (closing.length > 0) {
        if (!(await assignmentOf(db, sessionId, "exam"))) {
          const arcs = await examArcsRecord(db, session.trackId, closing);
          await writeAssignment(sessionId, "exam", EXAM_REQUEST, EXAM_RECORD_PROMPT, [
            { heading: EXAM_ARCS, body: arcs },
          ]);
        }
        await markArcsClosed(db, session, closing);
      }
      // The learner's turn now: the close follows their handing it in or putting it off.
      await applyEvent(db, sessionId, { type: "homework-assigned" });
    }),

    // The close: the recap, the term sweep, "where you left off". A final's close is its own
    // phase's, with what the final found (the two fix-lists, the teach-back's breaks) and what its
    // review found, and the plan's notes as written, which its sweep edits (design §7.4).
    recap: guarded(async ({ sessionId }) => {
      const closing = await closeContext(sessionId);
      const { context, final } = closing;
      const { session, terms, system } = context;
      // Tried again after it failed past the recap (in the sweep, say; retry.ts): the recap the
      // learner has read stands, and the close goes on from it. It is the conversation's last turn.
      const written = await writtenMessage(sessionId, "recap");
      const messages = written ? context.messages.slice(0, -1) : context.messages;
      const recap = written ?? {
        text: (
          await writeChatMessage({
            db,
            media: deps.media,
            review: reviewerFor(session),
            sessionId,
            model: await models.model({
              userId: session.userId,
              trackId: session.trackId,
              sessionId: session.id,
              purpose: "close",
              role: "strong",
            }),
            system,
            messages: [...messages, { role: "user", content: closing.request }],
            terms,
            kind: "recap",
          })
        ).text,
      };

      // The term sweep is its own call, so a rejected edit never means rewriting the recap; and its
      // own purpose, a structured record made with little reasoning (call-options.ts). It settles
      // the statuses from the evidence itself: the session's conversation as the recap saw it (a
      // long one's older turns summarized) and, in the system prompt, the check threads.
      const recapped: ModelMessage[] = [
        ...messages,
        { role: "user", content: closing.request },
        { role: "assistant", content: recap.text },
      ];
      let feedback = "";
      for (let attempt = 0; attempt < SWEEP_ATTEMPTS; attempt++) {
        const model = await models.model({
          userId: session.userId,
          trackId: session.trackId,
          sessionId: session.id,
          purpose: "term-sweep",
          role: "strong",
        });
        // Traced, so each attempt's verdict (the edits rejected) is stored on its call.
        const swept = await traced(() =>
          withActivity(db, sessionId, { code: "updating-terms" }, () =>
            generateText({
              model,
              system,
              output: Output.object({ schema: sweepActionsSchema }),
              messages: [
                ...recapped,
                {
                  role: "user",
                  content: `(For the app; the learner doesn't see this.) Now the term sweep: ${SWEEP_REQUEST}${final ? FINAL_SWEEP_REQUEST : ""}${feedback}`,
                },
              ],
            }),
          ),
        );
        const { output } = swept.value;
        if (output.actions.length === 0) {
          await swept.judge({ rewrite: attempt, issues: [] });
          break;
        }
        const options = { source: "close", rewritePlan: true };
        // The last attempt keeps what validates, so a bad edit doesn't cost the rest of the sweep.
        if (attempt + 1 === SWEEP_ATTEMPTS) {
          const { rejected } = await applyValidActions(
            db,
            session.trackId,
            output.actions,
            options,
          );
          await swept.judge({ rewrite: attempt, issues: rejectionIssues(rejected) });
          if (rejected.length > 0)
            log.warn(
              { attempts: SWEEP_ATTEMPTS, left: rejected.length },
              "term sweep rejected every time; closing with the edits that validate",
            );
          break;
        }
        const applied = await applyActions(db, session.trackId, output.actions, options);
        await swept.judge({
          rewrite: attempt,
          issues: applied.ok ? [] : rejectionIssues(applied.rejected),
        });
        if (applied.ok) break;
        log.info({ attempt: attempt + 1 }, "term sweep rejected; asking again");
        feedback = `\n\nThose edits were rejected:\n${applied.errors.map((e) => `- ${e}`).join("\n")}\nFix them.`;
      }

      // Then "where you left off", from the notes as the sweep left them and the whole session. A
      // failure leaves none rather than one from before this session: prompts then carry the notes.
      try {
        const { context: closed } = await closeContext(sessionId);
        await writeLeftOff({
          db,
          sessionId,
          trackId: session.trackId,
          model: await models.model({
            userId: session.userId,
            trackId: session.trackId,
            sessionId: session.id,
            purpose: "left-off",
            role: "strong",
          }),
          system: closed.system,
          messages: [...closed.messages, { role: "user", content: LEFT_OFF_PROMPT }],
          label: { code: "noting-left-off" },
        });
      } catch {
        await db.update(tracks).set({ leftOff: null }).where(eq(tracks.id, session.trackId));
      }
      await applyEvent(db, sessionId, { type: "recap-done" });
      // Every few closes, the learner's teaching notes are refreshed (profile.ts).
      if (await profileDue(db, session.userId)) await queue.enqueue("profile", { sessionId });
    }),

    plan: guarded(async ({ sessionId }) => {
      const { session, track, terms, messages } = await contextFor(sessionId, "plan");
      const modelFor = () =>
        models.model({
          userId: session.userId,
          trackId: session.trackId,
          sessionId: session.id,
          purpose: "plan",
          role: "strong",
        });

      // Research runs before the first plan only, as its own call: a search can't take the plan's place.
      // The probe's conclusion, stated for the plan (null when the learner skipped ahead to it).
      const probeFound = [
        ...reviewFound(session),
        ...(session.probeSummary
          ? [
              {
                heading: "What the probe found (the learner hasn't seen this)",
                body: session.probeSummary,
              },
            ]
          : []),
      ];
      const search =
        session.state.plan === "none" ? await models.searchTool(session.userId) : undefined;
      const found = search
        ? await research({
            db,
            sessionId,
            model: await modelFor(),
            system: systemFor("plan", { ...track, extra: probeFound }),
            messages,
            search,
            request: PLAN_RESEARCH_PROMPT,
            label: { code: "researching" },
          })
        : undefined;
      if (found) await storeResearch(db, { trackId: session.trackId, sessionId }, "plan", found);
      const notes = found?.notes ?? "";
      const system = systemFor("plan", {
        ...track,
        extra: [
          ...probeFound,
          ...(notes
            ? [{ heading: "Your research notes (the learner hasn't seen them)", body: notes }]
            : []),
        ],
      });

      let feedback: ModelMessage[] = [];
      let revising: Activity | undefined;
      try {
        for (let attempt = 0; attempt < PLAN_ATTEMPTS; attempt++) {
          // Each attempt is its own call, with the key decrypted for it.
          const model = await modelFor();
          const conversation = [...messages, ...feedback];
          const reply = await writeChatMessage({
            db,
            media: deps.media,
            review: reviewerFor(session),
            sessionId,
            model,
            system,
            messages: conversation,
            terms,
            kind: "plan",
          });
          // Traced, so the record's verdict (its edits rejected) is stored on its call.
          const recorded = await traced(() =>
            withActivity(db, sessionId, { code: "recording-plan" }, () =>
              generateText({
                model,
                system,
                output: Output.object({ schema: planActionsSchema }),
                messages: [
                  ...conversation,
                  { role: "assistant", content: reply.text },
                  { role: "user", content: PLAN_RECORD_PROMPT },
                ],
              }),
            ),
          );
          const { output } = recorded.value;
          const applied = output.actions.length
            ? await applyActions(db, session.trackId, output.actions, {
                source: "plan",
              })
            : {
                ok: false as const,
                errors: ["Record the plan's planned terms and place them in its arcs."],
                rejected: [],
              };
          await recorded.judge({
            rewrite: attempt,
            issues: applied.ok
              ? []
              : applied.rejected.length
                ? rejectionIssues(applied.rejected)
                : verdictIssues(applied.errors),
          });
          if (applied.ok) {
            // What the plan's picture is drawn around (term-map.ts).
            await db
              .update(sessionMessages)
              .set({ planTerms: plannedIn(output.actions) })
              .where(eq(sessionMessages.id, reply.messageId));
            await applyEvent(db, sessionId, { type: "plan-proposed" });
            return;
          }
          // The learner shouldn't see a plan that couldn't be recorded next to the corrected one.
          log.info(
            { attempt: attempt + 1, messageId: reply.messageId },
            "plan couldn't be recorded; retracting it",
          );
          await db.delete(sessionMessages).where(eq(sessionMessages.id, reply.messageId));
          await publish(db, sessionId, "message-retracted", { id: reply.messageId });
          await revising?.done();
          if (attempt + 1 < PLAN_ATTEMPTS)
            revising = await startActivity(db, sessionId, { code: "revising-plan" });
          feedback = [
            { role: "assistant", content: reply.text },
            {
              role: "user",
              content: `The plan couldn't be recorded:\n${applied.errors.map((e) => `- ${e}`).join("\n")}\nPresent the corrected plan.`,
            },
          ];
        }
      } finally {
        await revising?.done();
      }
      log.warn({ attempts: PLAN_ATTEMPTS }, "plan couldn't be recorded in any attempt");
      await publishFailure(db, sessionId, { code: "plan-failed" });
    }),
  };
}

/** What the opening review found, for the probe's and the plan's calls; none without one. */
function reviewFound(session: { reviewSummary: string | null }) {
  return session.reviewSummary ? [{ heading: REVIEW_FOUND, body: session.reviewSummary }] : [];
}

/** The track's context without what the learner brought, for a call that reads the files themselves. */
function withoutBrought(track: TrackContext): TrackContext {
  const rest = { ...track };
  delete rest.brought;
  return rest;
}
