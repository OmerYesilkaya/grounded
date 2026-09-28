import type { LanguageModelV4 } from "@ai-sdk/provider";
import {
  assembleSystemPrompt,
  checkVerdictSchema,
  generateLesson,
  planActionsSchema,
  probeDecisionSchema,
  stepInfoFor,
  trackActionSchema,
  type Method,
  type Phase,
  type PromptContext,
  type SessionState,
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
import { z } from "zod";
import { systemMessages } from "./call-options.js";
import { writeChatMessage } from "./chat.js";
import { publish, startActivity, withActivity, type Activity } from "./events.js";
import { NoCredentialError, ProviderCallError, type ModelAccess } from "./model-call.js";
import { addLogContext } from "../log.js";
import { reportHandledFailure, type JobQueue } from "./queue.js";
import { applyEvent, completeIfDone, loadSession, RejectedEvent } from "./session-store.js";
import { applyActions, loadTrackContext } from "./track-state.js";

export interface SessionTaskDependencies {
  db: Db;
  models: ModelAccess;
  method: Method;
  queue: JobQueue;
}

interface SessionJob {
  sessionId: string;
  stepId?: string;
}

const PLAN_ATTEMPTS = 3;
const SWEEP_ATTEMPTS = 3;

const RESEARCH_STEPS = 6;

const PROBE_DECISION_PROMPT =
  "(For the app; the learner doesn't see this.) Record what the learner's answers so far showed that isn't recorded yet. Then say whether probing is finished: you know where the learner's knowledge ends and what they want to reach, well enough to plan against, or they asked to move on to the plan. If it is finished, summarize both for the plan; you won't write another probe message, and the plan comes next, in its own message.";
const PLAN_RECORD_PROMPT =
  "(For the app; the learner doesn't see this.) Record the plan you just presented: every planned term with what it rests on, the arcs in order, and any misconceptions found in the probe as fix-list items.";
const RESEARCH_PROMPT =
  "(For the app; the learner doesn't see this.) Before planning, scope the field with web search: core concepts, real first principles, standard framings, common gotchas and the field's actual terminology. Prefer official docs and primary sources. Reply with research notes for yourself, with their sources.";

/** The tutor's reply when an answer couldn't be checked, so the learner can answer again. */
export const checkFailedText = (reason = "") =>
  `That didn't go through.${reason} Answer again when you're ready.`;

/** Adds a tutor message to a step's check thread and publishes it. */
export async function recordCheckMessage(
  db: Db,
  sessionId: string,
  stepId: string,
  text: string,
  verdict: "landed" | "missed" | null,
): Promise<void> {
  const blocks = parseBlocks(text).blocks;
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
  const { db, models, method, queue } = deps;
  /** A phase's system prompt, in the parts that let the provider cache its stable start. */
  const systemFor = (phase: Phase, context: PromptContext) =>
    systemMessages(assembleSystemPrompt(method, phase, context));

  const contextFor = async (sessionId: string, phase: Phase) => {
    const session = await loadSession(db, sessionId);
    const track = await loadTrackContext(db, session.trackId);
    const terms: TrackTerm[] = track.terms.map((t) => ({ term: t.term, status: t.status }));
    const history = await db
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(asc(sessionMessages.createdAt), asc(sessionMessages.id));
    const messages: ModelMessage[] = history.map((m) =>
      m.role === "learner"
        ? { role: "user", content: m.text ?? "" }
        : { role: "assistant", content: m.text ?? "" },
    );
    // A conversation starts with the learner; the app opens it on their behalf, with what they said
    // they want to learn (the track's title), so the first question builds on it.
    if (messages[0]?.role !== "user")
      messages.unshift({
        role: "user",
        content: `(The learner started a session. They said they want to learn: ${track.track.title})`,
      });
    const learnerHasSpoken = history.some((m) => m.role === "learner");
    return {
      session,
      track,
      terms,
      messages,
      learnerHasSpoken,
      system: systemFor(phase, track),
    };
  };

  const lessonRow = async (sessionId: string) => {
    const [row] = await db.select().from(lessons).where(eq(lessons.sessionId, sessionId));
    if (!row) throw new Error(`no lesson for session ${sessionId}`);
    return row;
  };

  /** The prompt for grading or re-asking a step: the check phase's method plus the step and its thread. */
  const checkPrompt = async (sessionId: string, stepId: string, state: SessionState) => {
    const session = await loadSession(db, sessionId);
    const track = await loadTrackContext(db, session.trackId);
    const lesson = await lessonRow(sessionId);
    const thread = await db
      .select()
      .from(checkMessages)
      .where(sql`${checkMessages.sessionId} = ${sessionId} and ${checkMessages.stepId} = ${stepId}`)
      .orderBy(asc(checkMessages.createdAt), asc(checkMessages.id));
    const index = state.lesson.steps.findIndex((s) => s.id === stepId);
    const nextRests = state.lesson.steps[index + 1]?.restsOnPrevious ?? false;
    const misses = state.steps[stepId]?.misses ?? 0;
    const introduced = (lesson.outline?.steps ?? [])
      .slice(0, index + 1)
      .flatMap((s) => s.introduces);
    const system = systemFor("check", {
      ...track,
      extra: [
        { heading: "The step being checked", body: lesson.stepSources[stepId] ?? "" },
        {
          heading: "Its check thread so far",
          body:
            thread
              .map((m) => `${m.role === "learner" ? "Learner" : "Tutor"}: ${m.text ?? ""}`)
              .join("\n") || "(none)",
        },
        {
          heading: "Where this step stands",
          body: [
            `Missed answers on this step so far: ${String(misses)}.`,
            nextRests
              ? "The next step rests on this one."
              : "The next step does not rest on this one.",
            misses >= 1
              ? "If this answer misses too, the idea is still settling: say so kindly, stop repairing, and give no fresh question."
              : "If this answer misses, repair that one piece and give a fresh question on the same idea.",
          ].join(" "),
        },
      ],
    });
    const terms: TrackTerm[] = track.terms.map((t) => ({ term: t.term, status: t.status }));
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
      const modelFor = (purpose: "probe" | "probe-decision") =>
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
          await applyActions(db, session.trackId, output.actions, { source: "probe" });
          // The question is written with what was just recorded (the teaching language, the fix-list).
          context = await contextFor(sessionId, "probe");
        }
        if (output.finished) {
          await db
            .update(learningSessions)
            .set({ probeSummary: output.summary })
            .where(eq(learningSessions.id, sessionId));
          await applyEvent(db, sessionId, { type: "probe-done" });
          await queue.enqueue("plan", { sessionId });
          return;
        }
      }
      await writeChatMessage({
        db,
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
      const outlining = await startActivity(db, sessionId, "Outlining the lesson");
      let writing: Activity | undefined;
      let totalSteps = 0;
      try {
        const result = await generateLesson({
          model,
          system,
          request: `Write the lesson for the approved plan. The session so far:\n\n${transcript}`,
          terms,
          onOutline: async (outline) => {
            await outlining.done();
            totalSteps = outline.steps.length;
            await db.update(lessons).set({ outline }).where(eq(lessons.sessionId, sessionId));
            // The steps are known from the outline, so the learner can start while later ones are written.
            await applyEvent(db, sessionId, { type: "lesson-ready", steps: stepInfoFor(outline) });
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
          onStepStart: async (index, attempt) => {
            await writing?.done();
            const which = `step ${String(index + 1)} of ${String(Math.max(totalSteps, index + 1))}`;
            writing = await startActivity(
              db,
              sessionId,
              attempt === 0 ? `Writing ${which}` : `Rewriting ${which} (the draft broke a rule)`,
            );
          },
        });
        if (result.failed.length > 0) {
          const failedSteps = result.failed.map(({ stepId, heading }) => ({ stepId, heading }));
          await db.update(lessons).set({ failedSteps }).where(eq(lessons.sessionId, sessionId));
          for (const failed of failedSteps)
            await publish(db, sessionId, "lesson-step-failed", failed);
        }
      } finally {
        await outlining.done();
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

        const grade = (feedback: string) =>
          withActivity(db, sessionId, "Checking your answer", async () => {
            const { output } = await generateText({
              model,
              system,
              output: Output.object({ schema: checkVerdictSchema }),
              prompt: `The learner's answer to this step's check: ${answer.text ?? ""}${feedback}`,
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
          verdict = await grade(
            `\n\nYour last reply broke these rules; fix them:\n${issues.map((i) => `- ${i.message}`).join("\n")}`,
          );
        }

        if (verdict.actions.length)
          await applyActions(db, session.trackId, verdict.actions, { source: `check ${stepId}` });
        const next = await applyEvent(db, sessionId, {
          type: "check-verdict",
          stepId,
          verdict: verdict.verdict,
        });
        await recordCheckMessage(db, sessionId, stepId, verdict.reply, verdict.verdict);

        const step = next.steps[stepId];
        if (verdict.verdict === "missed") {
          if (step?.status === "open" && !step.offerGate && verdict.freshQuestion) {
            await recordCheckMessage(db, sessionId, stepId, verdict.freshQuestion, null);
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
      await recordCheckMessage(db, sessionId, stepId, text, null);
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
      // own purpose, a structured record made with little reasoning (call-options.ts).
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
            output: Output.object({ schema: z.object({ actions: z.array(trackActionSchema) }) }),
            prompt: `The session is closing; your recap was:\n\n${recap.text}\n\nNow the term sweep: settle every term's status from the whole session's evidence, and record any change to the plan or the fix-list.${feedback}`,
          }),
        );
        const applied = output.actions.length
          ? await applyActions(db, session.trackId, output.actions, { source: "close" })
          : { ok: true as const };
        if (applied.ok) break;
        feedback = `\n\nThose edits were rejected:\n${applied.errors.map((e) => `- ${e}`).join("\n")}\nFix them.`;
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
            ? await applyActions(db, session.trackId, output.actions, { source: "plan" })
            : {
                ok: false as const,
                errors: ["Record the plan's planned terms and arcs."],
              };
          if (applied.ok) {
            await applyEvent(db, sessionId, { type: "plan-proposed" });
            return;
          }
          // The learner shouldn't see a plan that couldn't be recorded next to the corrected one.
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
