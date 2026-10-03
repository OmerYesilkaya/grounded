import { createDb } from "@grounded/db";
import { invite, listInvited, normalizeEmail, revoke, setOperator } from "./allowlist.js";

/*
 * Omer's side of sign-in (design §4.3, §10), run from a shell in the API service. `invite` mints
 * the one-time invite code and prints it once: it is not stored, so the same command is how a
 * lost code or a forgotten password is replaced. `list` shows who is invited and where their
 * sign-in stands, never the code or the password. `operator` lets an invited person read the admin
 * panel (§10.1), or stops them.
 */

const usage =
  "usage: pnpm cli invite <email> | pnpm cli revoke <email> | pnpm cli list | " +
  "pnpm cli operator add <email> | pnpm cli operator remove <email>";
const [command, ...args] = process.argv.slice(2);
const valid =
  ((command === "invite" || command === "revoke") && args.length === 1) ||
  (command === "list" && args.length === 0) ||
  (command === "operator" && (args[0] === "add" || args[0] === "remove") && args.length === 2);
if (!valid) {
  console.error(usage);
  process.exit(1);
}
const email = command === "operator" ? args[1] : args[0];
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const { db, close } = createDb(url);
try {
  if (command === "invite" && email) {
    const code = await invite(db, email);
    console.log(`invited ${normalizeEmail(email)}. Their invite code:\n\n    ${code}\n`);
    console.log(
      "Give it to them: they sign in with their email and this code as the password, and choose a " +
        "password of their own, which ends the code. It is not stored and can't be shown again; " +
        "running invite for this email again makes a new one, ends the old, and clears any " +
        "password they had chosen.",
    );
  } else if (command === "revoke" && email) {
    await revoke(db, email);
    console.log(`revoked ${normalizeEmail(email)}`);
  } else if (command === "operator" && email) {
    const add = args[0] === "add";
    if (!(await setOperator(db, email, add))) {
      console.error(`${normalizeEmail(email)} isn't invited: run invite first`);
      process.exitCode = 1;
    } else
      console.log(
        add
          ? `${normalizeEmail(email)} is an operator: they can open the admin panel at /admin`
          : `${normalizeEmail(email)} is no longer an operator`,
      );
  } else {
    const rows = await listInvited(db);
    if (rows.length === 0) console.log("nobody is invited");
    for (const row of rows) {
      const standing = row.passwordSetAt
        ? `password set ${row.passwordSetAt.toISOString()}`
        : row.codePending && row.codeIssuedAt
          ? `code issued ${row.codeIssuedAt.toISOString()}, not yet used`
          : "no code: run invite to issue one";
      const operator = row.operator ? "\toperator" : "";
      console.log(`${row.email}\tinvited ${row.invitedAt.toISOString()}\t${standing}${operator}`);
    }
  }
} finally {
  await close();
}
