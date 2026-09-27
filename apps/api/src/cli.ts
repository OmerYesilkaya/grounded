import { createDb } from "@grounded/db";
import { invite, normalizeEmail, revoke } from "./allowlist.js";

const [command, email] = process.argv.slice(2);
if ((command !== "invite" && command !== "revoke") || !email) {
  console.error("usage: pnpm invite <email> | pnpm revoke <email>");
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const { db, close } = createDb(url);
if (command === "invite") await invite(db, email);
else await revoke(db, email);
await close();
console.log(`${command === "invite" ? "invited" : "revoked"} ${normalizeEmail(email)}`);
