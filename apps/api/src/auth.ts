import { accounts, sessions, users, verifications, type Db } from "@grounded/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins/magic-link";
import { v7 as uuidv7 } from "uuid";
import { isInvited } from "./allowlist.js";

export interface AuthOptions {
  db: Db;
  baseURL: string;
  secret: string;
  trustedOrigins: string[];
  /** Delivers the link. Console in development; an email provider when deployed. */
  sendMagicLink: (email: string, url: string) => void | Promise<void>;
}

/**
 * Magic-link sign-in, invite-only. An uninvited email gets the same response as an invited one but
 * no link, so nobody can probe who is invited; creating an uninvited user is refused as well.
 */
export function createAuth(options: AuthOptions) {
  const { db } = options;
  return betterAuth({
    baseURL: options.baseURL,
    secret: options.secret,
    trustedOrigins: options.trustedOrigins,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user: users, session: sessions, account: accounts, verification: verifications },
    }),
    advanced: { database: { generateId: () => uuidv7() } },
    emailAndPassword: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => ((await isInvited(db, user.email)) ? { data: user } : false),
        },
      },
    },
    plugins: [
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          if (await isInvited(db, email)) await options.sendMagicLink(email, url);
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
