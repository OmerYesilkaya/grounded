import {
  assemblePrompt,
  trackActionSchema,
  type Method,
  type Phase,
  type TrackAction,
} from "@grounded/core";
import type { TrackTerm } from "@grounded/content";
import { asc, eq, sessionMessages, type Db } from "@grounded/db";
import { tool, type ModelMessage, type ToolSet } from "ai";
import type { Task, TaskList } from "graphile-worker";
import { z } from "zod";
import { writeChatMessage } from "./chat.js";
import { publish } from "./events.js";
import { NoCredentialError, ProviderCallError, type ModelAccess } from "./model-call.js";
import type { JobQueue } from "./queue.js";
import { applyEvent, loadSession } from "./session-store.js";
import { applyActions, loadTrackContext } from "./track-state.js";

export interface SessionTaskDependencies {
  db: Db;
  models: ModelAccess;
  method: Method;
  queue: JobQueue;
}

interface SessionJob {
  sessionId: string;
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
    return { session, terms, messages, system: assemblePrompt(method, phase, track) };
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
