import { createDb } from "@grounded/db";
import { invite, normalizeEmail, revoke } from "./allowlist.js";

const usage = "usage: pnpm cli invite <email> | pnpm cli revoke <email>";
const [command, email] = process.argv.slice(2);
if ((command !== "invite" && command !== "revoke") || !email) {
  console.error(usage);
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const { db, close } = createDb(url);
try {
  if (command === "invite") {
    await invite(db, email);
    console.log(`invited ${normalizeEmail(email)}: they sign in by entering it`);
  } else {
    await revoke(db, email);
    console.log(`revoked ${normalizeEmail(email)}`);
  }
} finally {
  await close();
}
