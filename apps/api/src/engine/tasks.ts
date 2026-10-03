import type { TaskList } from "graphile-worker";
import { createAsideTasks } from "./aside-tasks.js";
import { endingWhenGone } from "./gone.js";
import { createProbeVerdictTasks } from "./probe-verdict.js";
import { createProfileTasks } from "./profile.js";
import { createReviewTasks } from "./review-tasks.js";
import { createSessionTasks, type SessionTaskDependencies } from "./session-tasks.js";
import { createSourceTasks } from "./source-tasks.js";
import { createTrackTasks } from "./track-tasks.js";

/**
 * Every job the worker runs; a job whose track was deleted ends quietly (gone.ts). Every model
 * call the jobs make records the version of the method they run with.
 */
export function createTasks(given: SessionTaskDependencies): TaskList {
  const { models, method } = given;
  const deps: SessionTaskDependencies = {
    ...given,
    models: {
      model: (request) => models.model({ ...request, methodVersion: method.version }),
      searchTool: (userId) => models.searchTool(userId),
    },
  };
  return endingWhenGone(
    {
      ...createSessionTasks(deps),
      ...createAsideTasks(deps),
      ...createProbeVerdictTasks(deps),
      ...createTrackTasks(deps),
      ...createSourceTasks(deps),
      ...createProfileTasks(deps),
      ...createReviewTasks(deps),
    },
    deps.db,
  );
}
