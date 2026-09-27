import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client.js";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

export async function runMigrations(url: string): Promise<void> {
  const { db, close } = createDb(url);
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await close();
  }
}
