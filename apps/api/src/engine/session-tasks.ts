import {
  assemblePrompt,
  checkVerdictSchema,
  generateLesson,
  stepInfoFor,
  trackActionSchema,
  type Method,
  type Phase,
  type SessionState,
  type TrackAction,
} from "@grounded/core";
import { parseBlocks, validate, type TrackTerm } from "@grounded/content";
import { asc, checkMessages, eq, lessons, sessionMessages, sql, type Db } from "@grounded/db";
import { generateText, Output, tool, type ModelMessage, type ToolSet } from "ai";
import type { Task, TaskList } from "graphile-worker";
import { z } from "zod";
import { writeChatMessage } from "./chat.js";
import { publish } from "./events.js";
import { NoCredentialError, ProviderCallError, type ModelAccess } from "./model-call.js";
import type { JobQueue } from "./queue.js";
import { applyEvent, completeIfDone, loadSession } from "./session-store.js";
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

const recordTool = tool({
  description:
    "Record changes to the track: term statuses (with the learner's words as evidence), planned terms and what they rest on, fix-list items, the plan's arcs.",
  inputSchema: z.object({ actions: z.array(trackActionSchema) }),
});

const finishProbeTool = tool({
  description: "Call when the learner's level and goal are both clear enough to plan against.",
  inputSchema: z.object({
    summary: z.string().describe("Where the learner's knowledge ends, and their goal."),
  }),
});

const proposePlanTool = tool({
  description:
    "Record the plan you just presented: every planned term with what it rests on, the arcs in order, and any misconceptions found in the probe as fix-list items.",
  inputSchema: z.object({ actions: z.array(trackActionSchema) }),
});

/**
 * The SDK's ToolSet type rejects tool() results under exactOptionalPropertyTypes (its optional
 * callbacks are typed without `undefined`); the tools themselves are fine.
 */
const toolSet = (tools: Record<string, unknown>) => tools as ToolSet;

const actionsFrom = (
  calls: readonly { toolName: string; input: unknown }[],
  name: string,
): TrackAction[] =>
  calls
    .filter((c) => c.toolName === name)
    .flatMap((c) => (c.input as { actions: TrackAction[] }).actions);

/** The session's jobs. A failure the learner can act on is published as an error event. */
export function createSessionTasks(deps: SessionTaskDependencies): TaskList {
  const { db, models, method, queue } = deps;

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
    // A conversation starts with the learner; the app opens it on their behalf.
    if (messages[0]?.role !== "user")
      messages.unshift({ role: "user", content: "(The learner has started a session.)" });
    return { session, track, terms, messages, system: assemblePrompt(method, phase, track) };
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
    const system = assemblePrompt(method, "check", {
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

  const recordCheckMessage = async (
    sessionId: string,
    stepId: string,
    text: string,
    verdict: "landed" | "missed" | null,
  ) => {
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
  };

  const guarded =
    (run: (job: SessionJob) => Promise<void>): Task =>
    async (payload) => {
      const job = payload as SessionJob;
      try {
        await run(job);
      } catch (error) {
        const known = error instanceof ProviderCallError || error instanceof NoCredentialError;
        const message = known
          ? error.message
          : "Something went wrong on our side. Try again in a moment.";
        await publish(db, job.sessionId, "error", { message });
        if (!known) throw error;
      }
    };

  return {
    "probe-turn": guarded(async ({ sessionId }) => {
      const { session, terms, messages, system } = await contextFor(sessionId, "probe");
      const model = await models.model({
        userId: session.userId,
        purpose: "probe",
        role: "strong",
      });
      const reply = await writeChatMessage({
        db,
        sessionId,
        model,
        system,
        messages,
        terms,
        kind: "message",
        tools: toolSet({ record: recordTool, finish_probe: finishProbeTool }),
      });
      const recorded = actionsFrom(reply.toolCalls, "record");
      if (recorded.length) await applyActions(db, session.trackId, recorded, { source: "probe" });
      if (reply.toolCalls.some((c) => c.toolName === "finish_probe")) {
        await applyEvent(db, sessionId, { type: "probe-done" });
        await queue.enqueue("plan", { sessionId });
      }
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
        purpose: "lesson",
        role: "strong",
      });
      try {
        const result = await generateLesson({
          model,
          system,
          request: `Write the lesson for the approved plan. The session so far:\n\n${transcript}`,
          terms,
          onOutline: async (outline) => {
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
        });
        if (result.failed.length > 0) {
          const failedSteps = result.failed.map(({ stepId, heading }) => ({ stepId, heading }));
          await db.update(lessons).set({ failedSteps }).where(eq(lessons.sessionId, sessionId));
          for (const failed of failedSteps)
            await publish(db, sessionId, "lesson-step-failed", failed);
        }
      } catch (error) {
        if (error instanceof ProviderCallError) throw error;
        await applyEvent(db, sessionId, { type: "lesson-failed" });
        throw error;
      }
    }),

    check: guarded(async ({ sessionId, stepId }) => {
      if (!stepId) throw new Error("check job without a step");
      const { state } = await loadSession(db, sessionId);
      const { session, system, thread, terms, introduced } = await checkPrompt(
        sessionId,
        stepId,
        state,
      );
      const answer = thread.filter((m) => m.role === "learner").at(-1)?.text ?? "";
      const model = await models.model({
        userId: session.userId,
        purpose: "check",
        role: "strong",
      });

      const grade = async (feedback: string) =>
        (
          await generateText({
            model,
            system,
            output: Output.object({ schema: checkVerdictSchema }),
            prompt: `The learner's answer to this step's check: ${answer}${feedback}`,
          })
        ).output;
      const problems = (text: string | undefined) => {
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
      await recordCheckMessage(sessionId, stepId, verdict.reply, verdict.verdict);

      const step = next.steps[stepId];
      if (verdict.verdict === "missed") {
        if (step?.status === "open" && !step.offerGate && verdict.freshQuestion) {
          await recordCheckMessage(sessionId, stepId, verdict.freshQuestion, null);
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
    }),

    "fresh-question": guarded(async ({ sessionId, stepId }) => {
      if (!stepId) throw new Error("fresh-question job without a step");
      const { state } = await loadSession(db, sessionId);
      const { session, system } = await checkPrompt(sessionId, stepId, state);
      const model = await models.model({
        userId: session.userId,
        purpose: "check",
        role: "strong",
      });
      const { text } = await generateText({
        model,
        system,
        prompt:
          "The learner paused on this step last time and is back. Ask one fresh check question on the same idea, answerable in one or two lines. Reply with the question only.",
      });
      await recordCheckMessage(sessionId, stepId, text, null);
    }),

    plan: guarded(async ({ sessionId }) => {
      const { session, terms, messages, system } = await contextFor(sessionId, "plan");
      const search = await models.searchTool(session.userId);
      const tools = toolSet({
        propose_plan: proposePlanTool,
        ...(search ? { web_search: search } : {}),
      });

      let feedback: ModelMessage[] = [];
      for (let attempt = 0; attempt < PLAN_ATTEMPTS; attempt++) {
        // Each attempt is its own call, with the key decrypted for it.
        const model = await models.model({
          userId: session.userId,
          purpose: "plan",
          role: "strong",
        });
        const reply = await writeChatMessage({
          db,
          sessionId,
          model,
          system,
          messages: [...messages, ...feedback],
          terms,
          kind: "plan",
          tools,
          maxSteps: search ? 6 : 1,
        });
        const actions = actionsFrom(reply.toolCalls, "propose_plan");
        const applied = actions.length
          ? await applyActions(db, session.trackId, actions, { source: "plan" })
          : {
              ok: false as const,
              errors: ["Call propose_plan with the plan's planned terms and arcs."],
            };
        if (applied.ok) {
          await applyEvent(db, sessionId, { type: "plan-proposed" });
          return;
        }
        // The learner shouldn't see a plan that couldn't be recorded next to the corrected one.
        await db.delete(sessionMessages).where(eq(sessionMessages.id, reply.messageId));
        await publish(db, sessionId, "message-retracted", { id: reply.messageId });
        feedback = [
          { role: "assistant", content: reply.text },
          {
            role: "user",
            content: `The plan couldn't be recorded:\n${applied.errors.map((e) => `- ${e}`).join("\n")}\nPresent the corrected plan and call propose_plan again.`,
          },
        ];
      }
      await publish(db, sessionId, "error", {
        message: "The plan couldn't be put together. Try asking for it again.",
      });
    }),
  };
}
