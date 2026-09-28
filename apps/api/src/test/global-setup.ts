import type { TestProject } from "vitest/node";
import { createFreshDatabase } from "../embedded.js";

/** The server the test databases live on (its database name is the prefix for each run's). */
const SERVER_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://grounded:grounded@localhost:5432/grounded_test";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * A fresh, migrated database per run, dropped when the run ends. Each run gets its own, so two runs
 * at once (another worktree, an agent's run beside yours) don't drop each other's database.
 */
export default async function setup(project: TestProject) {
  const database = await createFreshDatabase(SERVER_URL, String(process.pid));
  project.provide("databaseUrl", database.url);
  return database.drop;
}
