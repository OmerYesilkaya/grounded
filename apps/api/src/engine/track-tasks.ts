import { cleanTitle, TITLE_MAX } from "@grounded/core";
import { eq, tracks, type Db } from "@grounded/db";
import { generateText, Output } from "ai";
import type { Task, TaskList } from "graphile-worker";
import { z } from "zod";
import type { FileStore } from "../files/store.js";
import { addLogContext, log } from "../log.js";
import { briefTrack } from "./brought.js";
import { NoCredentialError, ProviderCallError, type ModelAccess } from "./model-call.js";
import { reportHandledFailure } from "./queue.js";

export interface TrackTaskDependencies {
  db: Db;
  models: ModelAccess;
  files: FileStore;
}

interface TrackJob {
  trackId: string;
}

const NAME_SYSTEM = `You name a learner's track in a tutoring app: the few words the track list shows for it. The learner wrote what they want to learn. Name the subject, not the request: "Backend interviews", not "I want to pass backend interviews". At most ${String(TITLE_MAX)} characters, in the language the learner wrote in, no quotes or full stop.`;

/** The track's jobs, which belong to no session: a failure leaves the track as it was, and is logged. */
export function createTrackTasks(deps: TrackTaskDependencies): TaskList {
  const { db, models, files } = deps;

  const loadTrack = async (trackId: string) => {
    const [track] = await db.select().from(tracks).where(eq(tracks.id, trackId));
    if (!track) throw new Error(`no track ${trackId}`);
    addLogContext({ userId: track.userId, trackId });
    return track;
  };

  /** A failure the learner's key or provider explains is handled: the track keeps its stand-in. */
  const guarded =
    (run: (job: TrackJob) => Promise<void>): Task =>
    async (payload) => {
      try {
        await run(payload as TrackJob);
      } catch (error) {
        if (!(error instanceof ProviderCallError || error instanceof NoCredentialError))
          throw error;
        reportHandledFailure(error);
      }
    };

  return {
    // The learner's words ran long: the tutor names the track (design §9.5). Whatever happens, the
    // naming ends; the first line stands in if no name comes.
    "name-track": guarded(async ({ trackId }) => {
      const track = await loadTrack(trackId);
      try {
        const model = await models.model({
          userId: track.userId,
          trackId,
          purpose: "track-name",
          role: "cheap",
        });
        const { output } = await generateText({
          model,
          system: NAME_SYSTEM,
          output: Output.object({ schema: z.object({ name: z.string() }) }),
          prompt: `What the learner wrote:\n\n${track.goal}`,
        });
        const title = cleanTitle(output.name);
        if (title) await db.update(tracks).set({ title }).where(eq(tracks.id, trackId));
        else log.info("the tutor's name for the track was empty; keeping the stand-in");
      } finally {
        await db.update(tracks).set({ titlePending: false }).where(eq(tracks.id, trackId));
      }
    }),

    // Files came with the track: "what you brought" is written now, while the first session reads
    // the files themselves, so later calls have it (design §4.5). A later session's opening writes
    // it if this fails.
    "track-brief": guarded(async ({ trackId }) => {
      await loadTrack(trackId);
      await briefTrack({ db, store: files, models, trackId });
    }),
  };
}
