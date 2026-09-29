import { createDb } from "@grounded/db";
import { invite, normalizeEmail, revoke } from "./allowlist.js";
import { createInviteLink } from "./invite-link.js";

const usage = "usage: pnpm cli invite <email> | pnpm cli link <email> | pnpm cli revoke <email>";
const [command, email] = process.argv.slice(2);
if ((command !== "invite" && command !== "link" && command !== "revoke") || !email) {
  console.error(usage);
  process.exit(1);
}
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const { db, close } = createDb(required("DATABASE_URL"));
try {
  if (command === "invite") {
    await invite(db, email);
    console.log(`invited ${normalizeEmail(email)}`);
  } else if (command === "link") {
    const link = await createInviteLink({
      db,
      email,
      appUrl: required("APP_URL"),
      secret: required("BETTER_AUTH_SECRET"),
    });
    console.log(`invited ${normalizeEmail(email)}; this link signs them in once, within a week:`);
    console.log(link);
  } else {
    await revoke(db, email);
    console.log(`revoked ${normalizeEmail(email)}`);
  }
} finally {
  await close();
}
