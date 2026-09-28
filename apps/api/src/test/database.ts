import { inject } from "vitest";

/** This run's test database (global-setup.ts). */
export const TEST_DATABASE_URL = inject("databaseUrl");
