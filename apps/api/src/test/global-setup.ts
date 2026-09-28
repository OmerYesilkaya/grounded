import { runMigrations } from "@grounded/db";
import postgres from "postgres";
import type { TestProject } from "vitest/node";

/** The server the test databases live on (its database name is the prefix for each run's). */
const BASE_URL =
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
  const url = new URL(BASE_URL);
  url.pathname = `/${url.pathname.slice(1)}_${String(process.pid)}`;
  const name = url.pathname.slice(1);
  const admin = postgres({ ...parse(url), database: "postgres", onnotice: () => undefined });
  await admin.unsafe(`drop database if exists "${name}" with (force)`);
  await admin.unsafe(`create database "${name}"`);
  await runMigrations(url.toString());
  project.provide("databaseUrl", url.toString());

  return async () => {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.end();
  };
}

function parse(url: URL) {
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}
