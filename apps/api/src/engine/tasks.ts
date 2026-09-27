import type { TaskList } from "graphile-worker";
import { createSessionTasks, type SessionTaskDependencies } from "./session-tasks.js";

/** Every job the worker runs. */
export function createTasks(deps: SessionTaskDependencies): TaskList {
  return { ...createSessionTasks(deps) };
}
