import type { TaskList } from "graphile-worker";
import { endingWhenGone } from "./gone.js";
import { createSessionTasks, type SessionTaskDependencies } from "./session-tasks.js";
import { createTrackTasks } from "./track-tasks.js";

/** Every job the worker runs; a job whose track was deleted ends quietly (gone.ts). */
export function createTasks(deps: SessionTaskDependencies): TaskList {
  return endingWhenGone({ ...createSessionTasks(deps), ...createTrackTasks(deps) }, deps.db);
}
