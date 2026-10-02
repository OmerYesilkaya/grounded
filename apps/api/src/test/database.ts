import { inject } from "vitest";
import { createFreshDatabase } from "../embedded.js";

/*
 * This test file's database: a copy of the run's migrated template (global-setup.ts), one per
 * worker, so the files run in parallel without sharing one. The file before this one on the same
 * worker stopped its backend in `afterAll`, so its copy is dropped here and made again.
 */
const template = inject("templateDatabaseUrl");
const database = await createFreshDatabase(template, `w${process.env.VITEST_POOL_ID ?? "0"}`, {
  template,
});
// The copy stays until the run's end; only the connection that made it is closed.
await database.keep();

export const TEST_DATABASE_URL = database.url;
