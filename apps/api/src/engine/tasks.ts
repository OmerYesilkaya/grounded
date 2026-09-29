import type { TaskList } from "graphile-worker";
import { createAsideTasks } from "./aside-tasks.js";
import { endingWhenGone } from "./gone.js";
import { createProfileTasks } from "./profile.js";
import { createReviewTasks } from "./review-tasks.js";
import { createSessionTasks, type SessionTaskDependencies } from "./session-tasks.js";
import { createTrackTasks } from "./track-tasks.js";

/** Every job the worker runs; a job whose track was deleted ends quietly (gone.ts). */
export function createTasks(deps: SessionTaskDependencies): TaskList {
  return endingWhenGone(
    {
      ...createSessionTasks(deps),
      ...createAsideTasks(deps),
      ...createTrackTasks(deps),
      ...createProfileTasks(deps),
      ...createReviewTasks(deps),
    },
    deps.db,
  );
}
