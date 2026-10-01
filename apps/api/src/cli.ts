import { createDb } from "@grounded/db";
import { invite, listInvited, normalizeEmail, revoke } from "./allowlist.js";

/*
 * Omer's side of sign-in (design §4.3, §10), run from a shell in the API service. `invite` mints
 * the invite code and prints it once: it is not stored, so the same command is how a lost code is
 * replaced. `list` shows who is invited and when their code was issued, never the code.
 */

const usage = "usage: pnpm cli invite <email> | pnpm cli revoke <email> | pnpm cli list";
const [command, email] = process.argv.slice(2);
const wantsEmail = command === "invite" || command === "revoke";
if ((!wantsEmail && command !== "list") || (wantsEmail && !email) || (!wantsEmail && email)) {
  console.error(usage);
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const { db, close } = createDb(url);
try {
  if (command === "invite" && email) {
    const code = await invite(db, email);
    console.log(`invited ${normalizeEmail(email)}. Their invite code:\n\n    ${code}\n`);
    console.log(
      "Give it to them with the email; they sign in by entering both. The code is not stored and " +
        "can't be shown again: running invite for this email again makes a new one and ends the old.",
    );
  } else if (command === "revoke" && email) {
    await revoke(db, email);
    console.log(`revoked ${normalizeEmail(email)}`);
  } else {
    const rows = await listInvited(db);
    if (rows.length === 0) console.log("nobody is invited");
    for (const row of rows) {
      const code = row.codeIssuedAt
        ? `code issued ${row.codeIssuedAt.toISOString()}`
        : "no code yet: run invite to issue one";
      console.log(`${row.email}\tinvited ${row.invitedAt.toISOString()}\t${code}`);
    }
  }
} finally {
  await close();
}
