import { runMigrations } from "@grounded/db";
import postgres from "postgres";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://grounded:grounded@localhost:5432/grounded_test";

/** A fresh, migrated test database per run. */
export default async function setup() {
  const url = new URL(TEST_DATABASE_URL);
  const name = url.pathname.slice(1);
  const admin = postgres({ ...parse(url), database: "postgres" });
  await admin.unsafe(`drop database if exists "${name}" with (force)`);
  await admin.unsafe(`create database "${name}"`);
  await admin.end();

  await runMigrations(TEST_DATABASE_URL);
}

function parse(url: URL) {
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}
