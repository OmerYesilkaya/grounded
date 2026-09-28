import type { LanguageModelV4 } from "@ai-sdk/provider";
import {
  assembleSystemPrompt,
  checkVerdictSchema,
  generateLesson,
  planActionsSchema,
  probeDecisionSchema,
  placeChecks,
  sweepActionsSchema,
  trackActionsSchema,
  type Method,
  type Phase,
  type PromptContext,
  type SessionState,
  type TrackAction,
} from "@grounded/core";
import { parseBlocks, validate, type TrackTerm } from "@grounded/content";
import {
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
import {
  generateText,
  Output,
  stepCountIs,
  streamText,
  type ModelMessage,
  type SystemModelMessage,
  type Tool,
} from "ai";
import type { Task, TaskList } from "graphile-worker";
import { systemMessages } from "./call-options.js";
import { ASKED_IN_THE_MARGIN, asidesRecord } from "./asides.js";
import { alreadyHeldSoFar, checkRecord } from "./check-record.js";
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
import { publish, startActivity, withActivity, type Activity } from "./events.js";
import {
  LEFT_OFF_CATCH_UP,
  LEFT_OFF_CATCH_UP_PROMPT,
  LEFT_OFF_PROMPT,
  writeLeftOff,
} from "./left-off.js";
import { NoCredentialError, ProviderCallError, type ModelAccess } from "./model-call.js";
import type { FileStore } from "../files/store.js";
import { createLessonMedia } from "../media/lesson-media.js";
import { withVerifiedLinks, type VerifierOptions } from "../media/verify.js";
import { addLogContext, log } from "../log.js";
import { reportHandledFailure, type JobQueue } from "./queue.js";
import { applyEvent, completeIfDone, loadSession, RejectedEvent } from "./session-store.js";
import {
  applyActions,
  applyValidActions,
  loadTrackContext,
  type RejectedAction,
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

const RESEARCH_STEPS = 6;

/** The phases after the lesson, whose calls carry what happened at its checks. */
const AFTER_CHECKS_PHASES: readonly Phase[] = ["homework", "close"];

const PROBE_DECISION_PROMPT =
  "(For the app; the learner doesn't see this.) Record what the learner's answers so far showed that isn't recorded yet. Then say whether probing is finished: you know where the learner's knowledge ends and what they want to reach, well enough to plan against, or they asked to move on to the plan. If it is finished, you won't write another probe message: the plan comes next, in its own message.";
const PROBE_SUMMARY_PROMPT =
  "(For the app; the learner doesn't see this.) The probe is finished. Write what it found, for the plan: for each strand the lesson will lean on, what the learner holds and where it stops, in their own words where you can. Where you found where a strand stops but not what they hold below it, say so; that is not the same as holding nothing. Then what they want to reach. Plain prose, no preamble.";
const PLAN_RECORD_PROMPT =
  "(For the app; the learner doesn't see this.) Record the plan you just presented: every planned term with what it rests on (a term already in the term list, shown here or not, keeps its status; planning it again only adds what it rests on), and any misconceptions found in the probe as fix-list items. Then place this session's new planned terms in the plan's arcs with add-to-arc: each in the existing arc it belongs to, named by that arc's exact title as the plan shows it; a new arc (added at the end) only for terms no existing arc fits. This doesn't change the rest of the plan: its other arcs and terms stay as they are. If the track has no arcs yet, name the first ones. Record anything you noted for later sessions (a reorder, a detour, what to come back to) with add-plan-notes.";
const SWEEP_REQUEST =
  "settle every term's status from the whole session's evidence, and record any change to the plan or the fix-list. Change the plan's notes a section at a time with edit-plan-notes: the section's heading line as the notes write it, and its new text (null removes the section; a heading no section has adds one at the end). Fold what was \"Noted while planning\" into the sections it belongs to, then remove that section. Change the arcs with set-plan, notes null to keep the notes as they are.";
const RESEARCH_PROMPT =
  "(For the app; the learner doesn't see this.) Before planning, scope the field with web search: core concepts, real first principles, standard framings, common gotchas and the field's actual terminology. Prefer official docs and primary sources. Reply with research notes for yourself, with their sources.";

/** What a call hears about its rejected track edits, to send them again corrected. */
const rejectedFeedback = (rejected: readonly RejectedAction[]) =>
  [
    "(For the app; the learner doesn't see this.) Some of your track edits were rejected and not recorded; the others were recorded:",
    ...rejected.map((r) => `- ${JSON.stringify(r.action)}: ${r.reason}`),
    "Send these edits again, corrected, and only these. Leave out any that shouldn't be made after all.",
  ].join("\n");

/** The tutor's reply when an answer couldn't be checked, so the learner can answer again. */
export const checkFailedText = (reason = "") =>
  `That didn't go through.${reason} Answer again when you're ready.`;

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
): Promise<void> {
  const parsed = parseBlocks(text).blocks;
  const blocks = media ? await withVerifiedLinks(parsed, media) : parsed;
  const [row] = await db
    .insert(checkMessages)
    .values({ sessionId, stepId, role: "tutor", text, blocks, verdict })
    .returning();
  if (!row) throw new Error("check message insert returned nothing");
  await publish(db, sessionId, "check-message", {
    id: row.id,
    stepId,
    role: "tutor",
    blocks,
    verdict,
  });
}

/** The session's jobs. A failure the learner can act on is published as an error event. */
export function createSessionTasks(deps: SessionTaskDependencies): TaskList {
  const { db, models, method, queue, files } = deps;
  /** A phase's system prompt, in the parts that let the provider cache its stable start. */
  const systemFor = (phase: Phase, context: PromptContext) =>
    systemMessages(assembleSystemPrompt(method, phase, context));

  const contextFor = async (sessionId: string, phase: Phase) => {
    const session = await loadSession(db, sessionId);
    const loaded = await loadTrackContext(db, session.trackId, { sessionId, phase });
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
    const checks = after ? await checksSoFar(sessionId, session) : null;
    // And the questions asked in the margin, which the close carries on to the next session.
    const asked = after ? await asidesRecord(db, sessionId) : null;
    const extra = [
      ...(checks ? [{ heading: "What happened at the lesson's checks", body: checks }] : []),
      ...(asked ? [{ heading: ASKED_IN_THE_MARGIN, body: asked }] : []),
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
    const learnerHasSpoken = history.some((m) => m.role === "learner");
    return { session, track, terms, messages, learnerHasSpoken, system };
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

  /** The lesson's check record (check-record.ts), or null when there is no lesson or no answer yet. */
  const checksSoFar = async (sessionId: string, session: { state: SessionState }) => {
    const [lesson] = await db.select().from(lessons).where(eq(lessons.sessionId, sessionId));
    if (!lesson) return null;
    return checkRecord({
      steps: session.state.lesson.steps,
      headings: (lesson.outline?.steps ?? []).map((s) => s.heading),
      sources: lesson.stepSources,
      threads: await threadsOf(sessionId),
      notes: lesson.notes,
      alreadyHeld: lesson.alreadyHeld,
    });
  };

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
          purpose: "left-off",
          role: "strong",
        }),
        system: systemFor("close", whole),
        messages: [{ role: "user", content: LEFT_OFF_CATCH_UP_PROMPT }],
        label: "Reading where you left off",
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
      const brief = await withActivity(db, session.id, "Reading what you brought", () =>
        briefTrack({ db, store: files, models, trackId: session.trackId }),
      );
      return brief !== null;
    } catch {
      return false;
    }
  };

  /**
   * Records the track edits a call made alongside its real work (the probe's decision, a check's
   * verdict; design §5): what validates is applied, and what doesn't goes back to the call once,
   * with the reasons, and what validates of its answer is applied too. Asking again is best-effort:
   * if it fails, what was applied stands and the rest is left out (logged).
   */
  const recordEdits = async (options: {
    sessionId: string;
    trackId: string;
    actions: readonly TrackAction[];
    source: string;
    /** The activity the call's own work showed. */
    label: string;
    /** Asks the call again, with the rejected edits and why; returns the edits it sends instead. */
    askAgain: (feedback: string) => Promise<readonly TrackAction[]>;
  }) => {
    const { trackId, source } = options;
    const { rejected } = await applyValidActions(db, trackId, options.actions, { source });
    if (rejected.length === 0) return;
    log.info({ source, rejected: rejected.length }, "track edits rejected; asking again");
    try {
      const again = await withActivity(db, options.sessionId, options.label, () =>
        options.askAgain(rejectedFeedback(rejected)),
      );
      const still = again.length
        ? (await applyValidActions(db, trackId, again, { source })).rejected
        : [];
      if (still.length > 0)
        log.warn(
          { source, codes: still.map((r) => r.code) },
          "track edits rejected again; left out",
        );
    } catch (error) {
      log.warn({ source, err: error }, "asking again for rejected track edits failed; left out");
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
        const known = error instanceof ProviderCallError || error instanceof NoCredentialError;
        const message = known
          ? error.message
          : "Something went wrong on our side. Try again in a moment.";
        await publish(db, job.sessionId, "error", { message });
        if (!known) throw error;
        reportHandledFailure(error);
      }
    };

  return {
    // Decide first, then write: a turn that finishes the probe writes no probe message, so a model
    // that feels done can't present the plan there; the plan job is the only place a plan appears.
    "probe-turn": guarded(async ({ sessionId }) => {
      let context = await contextFor(sessionId, "probe");
      const { session } = context;
      // Before the opening question, once: long notes with no summary yet get one (an import), and
      // files with no summary yet get one.
      if (!context.learnerHasSpoken) {
        const leftOff = await catchUpLeftOff(session);
        const brief = await catchUpBrief(session);
        if (leftOff || brief) context = await contextFor(sessionId, "probe");
      }
      const modelFor = (purpose: "probe" | "probe-decision" | "probe-summary") =>
        models.model({ userId: session.userId, trackId: session.trackId, purpose, role: "strong" });
      // The opening question follows nothing the learner said: nothing to record, nothing decided.
      if (context.learnerHasSpoken) {
        // Its own purpose: a small structured record, made with little reasoning (call-options.ts).
        const decider = await modelFor("probe-decision");
        const { output } = await withActivity(
          db,
          sessionId,
          "Noting what your answers showed",
          () =>
            generateText({
              model: decider,
              system: context.system,
              output: Output.object({ schema: probeDecisionSchema }),
              messages: [...context.messages, { role: "user", content: PROBE_DECISION_PROMPT }],
            }),
        );
        if (output.actions.length) {
          await recordEdits({
            sessionId,
            trackId: session.trackId,
            actions: output.actions,
            source: "probe",
            label: "Noting what your answers showed",
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
            "Working out where your knowledge ends",
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
        sessionId,
        model: await modelFor("probe"),
        system: context.system,
        messages: context.messages,
        terms: context.terms,
        kind: "message",
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
        purpose: "lesson",
        role: "strong",
      });
      const outlining = resume
        ? undefined
        : await startActivity(db, sessionId, "Outlining the lesson");
      let writing: Activity | undefined;
      let totalSteps = resume?.outline.steps.length ?? 0;
      try {
        const result = await generateLesson({
          model,
          system,
          request: `Write the lesson for the approved plan. The session so far:\n\n${transcript}`,
          terms,
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
            await publish(db, sessionId, "lesson-step", { step });
          },
          onOutlineRejected: (attempt, problems) => {
            log.info(
              { attempt, problems },
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
            const which = `step ${String(index + 1)} of ${String(Math.max(totalSteps, index + 1))}`;
            writing = await startActivity(
              db,
              sessionId,
              attempt === 0 ? `Writing ${which}` : `Rewriting ${which} (the draft broke a rule)`,
            );
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
          purpose: "check",
          role: "strong",
        });

        const request = (feedback: string) =>
          `The learner's answer to this step's check: ${answer.text ?? ""}${feedback}`;
        const grade = (feedback: string) =>
          withActivity(db, sessionId, "Checking your answer", async () => {
            const { output } = await generateText({
              model,
              system,
              output: Output.object({ schema: checkVerdictSchema }),
              prompt: request(feedback),
            });
            return output;
          });
        const problems = (text: string | null) => {
          if (!text) return [];
          const parsed = parseBlocks(text);
          return [
            ...parsed.issues,
            ...validate(parsed.blocks, { surface: "repair", terms, introduced }),
          ].filter((i) => i.severity !== "review");
        };
        let verdict = await grade("");
        const issues = [...problems(verdict.reply), ...problems(verdict.freshQuestion)];
        if (issues.length > 0) {
          log.info({ issues: issues.map((i) => i.code) }, "check reply broke rules; grading again");
          verdict = await grade(
            `\n\nYour last reply broke these rules; fix them:\n${issues.map((i) => `- ${i.message}`).join("\n")}`,
          );
        }

        const graded = verdict;
        if (graded.actions.length)
          await recordEdits({
            sessionId,
            trackId: session.trackId,
            actions: graded.actions,
            source: `check ${stepId}`,
            label: "Checking your answer",
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
        await recordCheckMessage(db, sessionId, stepId, verdict.reply, verdict.verdict, deps.media);

        const step = next.steps[stepId];
        if (verdict.verdict === "missed") {
          if (step?.status === "open" && !step.offerGate && verdict.freshQuestion) {
            await recordCheckMessage(
              db,
              sessionId,
              stepId,
              verdict.freshQuestion,
              null,
              deps.media,
            );
          }
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
        const reason =
          error instanceof ProviderCallError || error instanceof NoCredentialError
            ? ` ${error.message}`
            : "";
        await recordCheckMessage(db, sessionId, stepId, checkFailedText(reason), null);
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
        purpose: "check",
        role: "strong",
      });
      const { text } = await withActivity(db, sessionId, "Writing a fresh question", () =>
        generateText({
          model,
          system,
          prompt:
            "The learner paused on this step last time and is back. Ask one fresh check question on the same idea, answerable in one or two lines. Reply with the question only.",
        }),
      );
      await recordCheckMessage(db, sessionId, stepId, text, null, deps.media);
    }),

    homework: guarded(async ({ sessionId }) => {
      const { session, terms, messages, system } = await contextFor(sessionId, "homework");
      const model = await models.model({
        userId: session.userId,
        trackId: session.trackId,
        purpose: "homework",
        role: "strong",
      });
      await writeChatMessage({
        db,
        media: deps.media,
        sessionId,
        model,
        system,
        messages: [
          ...messages,
          { role: "user", content: "(The lesson's checks are done. Assign the homework.)" },
        ],
        terms,
        kind: "homework",
        surface: "homework",
      });
      await applyEvent(db, sessionId, { type: "homework-assigned" });
      await queue.enqueue("recap", { sessionId });
    }),

    recap: guarded(async ({ sessionId }) => {
      const { session, terms, messages, system } = await contextFor(sessionId, "close");
      const recap = await writeChatMessage({
        db,
        media: deps.media,
        sessionId,
        model: await models.model({
          userId: session.userId,
          trackId: session.trackId,
          purpose: "close",
          role: "strong",
        }),
        system,
        messages: [...messages, { role: "user", content: "(Close the session: the recap.)" }],
        terms,
        kind: "recap",
      });

      // The term sweep is its own call, so a rejected edit never means rewriting the recap; and its
      // own purpose, a structured record made with little reasoning (call-options.ts). It settles
      // the statuses from the evidence itself: the session's conversation as the recap saw it (a
      // long one's older turns summarized) and, in the system prompt, the check threads.
      const closing: ModelMessage[] = [
        ...messages,
        { role: "user", content: "(Close the session: the recap.)" },
        { role: "assistant", content: recap.text },
      ];
      let feedback = "";
      for (let attempt = 0; attempt < SWEEP_ATTEMPTS; attempt++) {
        const model = await models.model({
          userId: session.userId,
          trackId: session.trackId,
          purpose: "term-sweep",
          role: "strong",
        });
        const { output } = await withActivity(db, sessionId, "Updating your term list", () =>
          generateText({
            model,
            system,
            output: Output.object({ schema: sweepActionsSchema }),
            messages: [
              ...closing,
              {
                role: "user",
                content: `(For the app; the learner doesn't see this.) Now the term sweep: ${SWEEP_REQUEST}${feedback}`,
              },
            ],
          }),
        );
        if (output.actions.length === 0) break;
        const options = { source: "close", rewritePlan: true };
        // The last attempt keeps what validates, so a bad edit doesn't cost the rest of the sweep.
        if (attempt + 1 === SWEEP_ATTEMPTS) {
          const { rejected } = await applyValidActions(
            db,
            session.trackId,
            output.actions,
            options,
          );
          if (rejected.length > 0)
            log.warn(
              { attempts: SWEEP_ATTEMPTS, left: rejected.length },
              "term sweep rejected every time; closing with the edits that validate",
            );
          break;
        }
        const applied = await applyActions(db, session.trackId, output.actions, options);
        if (applied.ok) break;
        log.info({ attempt: attempt + 1 }, "term sweep rejected; asking again");
        feedback = `\n\nThose edits were rejected:\n${applied.errors.map((e) => `- ${e}`).join("\n")}\nFix them.`;
      }

      // Then "where you left off", from the notes as the sweep left them and the whole session. A
      // failure leaves none rather than one from before this session: prompts then carry the notes.
      try {
        const closed = await contextFor(sessionId, "close");
        await writeLeftOff({
          db,
          sessionId,
          trackId: session.trackId,
          model: await models.model({
            userId: session.userId,
            trackId: session.trackId,
            purpose: "left-off",
            role: "strong",
          }),
          system: closed.system,
          messages: [...closed.messages, { role: "user", content: LEFT_OFF_PROMPT }],
          label: "Noting where you left off",
        });
      } catch {
        await db.update(tracks).set({ leftOff: null }).where(eq(tracks.id, session.trackId));
      }
      await applyEvent(db, sessionId, { type: "recap-done" });
    }),

    plan: guarded(async ({ sessionId }) => {
      const { session, track, terms, messages } = await contextFor(sessionId, "plan");
      const modelFor = () =>
        models.model({
          userId: session.userId,
          trackId: session.trackId,
          purpose: "plan",
          role: "strong",
        });

      // Research runs before the first plan only, as its own call: a search can't take the plan's place.
      // The probe's conclusion, stated for the plan (null when the learner skipped ahead to it).
      const probeFound = session.probeSummary
        ? [
            {
              heading: "What the probe found (the learner hasn't seen this)",
              body: session.probeSummary,
            },
          ]
        : [];
      const search =
        session.state.plan === "none" ? await models.searchTool(session.userId) : undefined;
      const notes = search
        ? await research({
            db,
            sessionId,
            model: await modelFor(),
            system: systemFor("plan", { ...track, extra: probeFound }),
            messages,
            search,
          })
        : "";
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
            sessionId,
            model,
            system,
            messages: conversation,
            terms,
            kind: "plan",
          });
          const { output } = await withActivity(db, sessionId, "Recording the plan's terms", () =>
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
          );
          const applied = output.actions.length
            ? await applyActions(db, session.trackId, output.actions, {
                source: "plan",
              })
            : {
                ok: false as const,
                errors: ["Record the plan's planned terms and place them in its arcs."],
              };
          if (applied.ok) {
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
            revising = await startActivity(
              db,
              sessionId,
              "Revising the plan (the first draft didn't fit)",
            );
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
      await publish(db, sessionId, "error", {
        message: "The plan couldn't be put together. Try asking for it again.",
      });
    }),
  };
}

/** The planning research: the provider's web search, returned as notes for the plan's calls. */
async function research(options: {
  db: Db;
  sessionId: string;
  model: LanguageModelV4;
  system: SystemModelMessage[];
  messages: ModelMessage[];
  search: Tool;
}): Promise<string> {
  const { db, sessionId } = options;
  return withActivity(db, sessionId, "Researching the subject", async (researching) => {
    const searches = new Map<string, Activity>();
    try {
      const reply = streamText({
        model: options.model,
        system: options.system,
        messages: [...options.messages, { role: "user", content: RESEARCH_PROMPT }],
        tools: { web_search: options.search },
        stopWhen: stepCountIs(RESEARCH_STEPS),
      });
      for await (const part of reply.stream) {
        if (part.type === "error") throw part.error;
        if (part.type === "reasoning-delta") await researching.reasoning(part.text);
        if (part.type === "tool-call" && part.toolName === "web_search") {
          const label = searchLabel(searchQuery(part.input));
          searches.set(part.toolCallId, await startActivity(db, sessionId, label));
        }
        if (part.type === "tool-result" && part.toolName === "web_search") {
          const searching = searches.get(part.toolCallId);
          const query = searchQuery(part.output);
          if (query) await searching?.update({ label: searchLabel(query) });
          await searching?.done();
        }
      }
      return await reply.text;
    } finally {
      for (const searching of searches.values()) await searching.done();
    }
  });
}

const searchLabel = (query: string | undefined) =>
  query ? `Searching the web for “${query}”` : "Searching the web";

/** A search's query, where the provider reports it: in the call's input or the result's action. */
function searchQuery(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if ("query" in value && typeof value.query === "string") return value.query;
  if ("action" in value) return searchQuery(value.action);
  return undefined;
}

/** The track's context without what the learner brought, for a call that reads the files themselves. */
function withoutBrought(track: TrackContext): TrackContext {
  const rest = { ...track };
  delete rest.brought;
  return rest;
}
