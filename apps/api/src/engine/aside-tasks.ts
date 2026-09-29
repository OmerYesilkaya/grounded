import {
  ASIDE_RECORD_PROMPT,
  asideBlocksLine,
  asideLesson,
  asidePassage,
  asideRecord,
  asideRecordSchema,
  assembleSystemPrompt,
  type Method,
} from "@grounded/core";
import type { Block } from "@grounded/content";
import { asides, eq, lessons, type Db } from "@grounded/db";
import { generateText, Output, type ModelMessage } from "ai";
import type { Task, TaskList } from "graphile-worker";
import { addLogContext, log } from "../log.js";
import type { VerifierOptions } from "../media/verify.js";
import {
  asideFailedText,
  asThreads,
  loadAsides,
  openSteps,
  recordAsideEvidence,
  recordAsideMessage,
  stepNumber,
  waitingFor,
  type LoadedAside,
} from "./asides.js";
import { systemMessages } from "./call-options.js";
import { composeReply } from "./chat.js";
import { publish } from "./events.js";
import { NoCredentialError, ProviderCallError, type ModelAccess } from "./model-call.js";
import { reportHandledFailure } from "./queue.js";
import { createReviewer } from "./review.js";
import { loadSession } from "./session-store.js";
import { loadTrackContext } from "./track-state.js";

export interface AsideTaskDependencies {
  db: Db;
  models: ModelAccess;
  method: Method;
  /** Where an answer's links are verified (design §6.4). */
  media: VerifierOptions;
}

interface AsideJob {
  sessionId: string;
  asideId: string;
}

/**
 * The aside's job (design §7.5): the answer to the learner's latest question in an aside, streamed
 * into its card by the cheaper model, then a small record of what the question showed (evidence on
 * the track's terms, a tangent to offer for a future session). A failed answer says so in the card,
 * so the learner can ask again; the session goes on regardless.
 */
export function createAsideTasks(deps: AsideTaskDependencies): TaskList {
  const { db, models, method, media } = deps;

  /** The aside's prompt: the aside phase's method, the track, the whole lesson and the passage. */
  const promptFor = async (sessionId: string, aside: LoadedAside, earlier: LoadedAside[]) => {
    const session = await loadSession(db, sessionId);
    const track = await loadTrackContext(db, session.trackId, { sessionId, phase: "aside" });
    const [lesson] = await db.select().from(lessons).where(eq(lessons.sessionId, sessionId));
    const outline = lesson?.outline?.steps ?? [];
    const open = openSteps(session.state);
    const stepIds = outline.map((_, i) => `s${String(i + 1)}`);
    const body = asideLesson(
      outline.map((step, i) => ({
        id: stepIds[i] ?? "",
        heading: step.heading,
        source: lesson?.stepSources[stepIds[i] ?? ""] ?? null,
        open: open.has(stepIds[i] ?? ""),
      })),
    );
    const earlierRecord = asideRecord(asThreads(earlier), stepNumber);
    const number = stepNumber(aside.stepId);
    const system = systemMessages(
      assembleSystemPrompt(method, "aside", {
        ...track,
        // Stable first: the lesson is the same for every aside on it.
        extra: [
          { heading: "The lesson", body },
          ...(earlierRecord
            ? [{ heading: "Earlier asides on this lesson", body: earlierRecord }]
            : []),
          {
            heading: "The passage this aside is about",
            body: `${asidePassage(aside.anchor, {
              number,
              heading: outline[number - 1]?.heading ?? "",
            })}\n\n${asideBlocksLine()}`,
          },
        ],
      }),
    );
    const messages: ModelMessage[] = aside.messages.map((m) =>
      m.role === "learner"
        ? { role: "user", content: m.text }
        : { role: "assistant", content: m.text },
    );
    // What the lesson taught up to where the learner is may be used; the steps ahead may not.
    const introduced = outline.flatMap((step, i) =>
      open.has(stepIds[i] ?? "") ? step.introduces : [],
    );
    return { session, system, messages, terms: track.current, introduced };
  };

  const aside: Task = async (payload) => {
    const { sessionId, asideId } = payload as AsideJob;
    const { userId, trackId } = await loadSession(db, sessionId);
    addLogContext({ userId, trackId, asideId });
    const all = await loadAsides(db, sessionId);
    const index = all.findIndex((a) => a.id === asideId);
    const current = all[index];
    if (!current) throw new Error(`no aside ${asideId}`);
    // Only a question still waiting is answered: recovery may have answered it already.
    const question = waitingFor(current);
    if (!question) return;

    let answer: { text: string; blocks: Block[] };
    let prompt: Awaited<ReturnType<typeof promptFor>>;
    try {
      prompt = await promptFor(sessionId, current, all.slice(0, index));
      const model = await models.model({
        userId,
        trackId,
        sessionId,
        purpose: "aside",
        role: "cheap",
      });
      answer = await composeReply({
        db,
        sessionId,
        model,
        system: prompt.system,
        messages: prompt.messages,
        terms: prompt.terms,
        introduced: prompt.introduced,
        surface: "aside",
        activities: false,
        onText: async (text) => {
          await publish(db, sessionId, "aside-delta", { asideId, replyTo: question.id, text });
        },
        logFields: { asideId },
        media,
        review: createReviewer(db, models, { userId, trackId, sessionId }),
      });
      await recordAsideMessage(db, sessionId, asideId, { role: "tutor", ...answer });
    } catch (error) {
      // Otherwise the card waits forever: say so in it, so the learner can ask again.
      const known = error instanceof ProviderCallError || error instanceof NoCredentialError;
      await recordAsideMessage(db, sessionId, asideId, {
        role: "tutor",
        text: asideFailedText(known ? ` ${error.message}` : ""),
      });
      if (!known) throw error;
      reportHandledFailure(error);
      return;
    }

    // The record comes after the answer, so the answer never waits for it; if it fails, the aside
    // simply has none.
    try {
      const model = await models.model({
        userId,
        trackId,
        sessionId,
        purpose: "aside-record",
        role: "cheap",
      });
      const { output } = await generateText({
        model,
        system: prompt.system,
        output: Output.object({ schema: asideRecordSchema }),
        messages: [
          ...prompt.messages,
          { role: "assistant", content: answer.text },
          { role: "user", content: ASIDE_RECORD_PROMPT },
        ],
      });
      await recordAsideEvidence(db, trackId, output.evidence);
      const tangent = output.tangent?.trim();
      if (tangent && current.savedAt === null) {
        await db.update(asides).set({ tangent }).where(eq(asides.id, asideId));
        await publish(db, sessionId, "aside-tangent", { asideId, tangent });
      }
    } catch (error) {
      log.warn({ err: error }, "aside's record failed; the aside has none");
    }
  };

  return { aside };
}
