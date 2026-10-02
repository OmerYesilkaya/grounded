import type { TestProject } from "vitest/node";
import { createFreshDatabase } from "../embedded.js";

/** The server the test databases live on (its database name is the prefix for each run's). */
const SERVER_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://grounded:grounded@localhost:5432/grounded_test";

declare module "vitest" {
  export interface ProvidedContext {
    /** The run's migrated database, which no test touches: each worker's is a copy of it (database.ts). */
    templateDatabaseUrl: string;
  }
}

/**
 * A fresh, migrated database per run, dropped with its copies when the run ends. Each run gets its
 * own, so two runs at once (another worktree, an agent's run beside yours) don't drop each other's.
 */
export default async function setup(project: TestProject) {
  const template = await createFreshDatabase(SERVER_URL, String(process.pid));
  project.provide("templateDatabaseUrl", template.url);
  return template.drop;
}
