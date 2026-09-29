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
  /**
   * The host's proxies (IPs or CIDR ranges). The client's address is the last X-Forwarded-For hop
   * before them; without it, every client shares one rate-limit bucket.
   */
  trustedProxies?: string[];
  /** Rate limiting is on in production by default; tests turn it on to check it. */
  rateLimit?: boolean;
  /** How long a magic link stays valid, in seconds. Better Auth's five minutes by default. */
  magicLinkExpiresIn?: number;
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
    advanced: {
      database: { generateId: () => uuidv7() },
      ipAddress: { trustedProxies: options.trustedProxies ?? [] },
    },
    ...(options.rateLimit === undefined ? {} : { rateLimit: { enabled: options.rateLimit } }),
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
        ...(options.magicLinkExpiresIn === undefined
          ? {}
          : { expiresIn: options.magicLinkExpiresIn }),
        sendMagicLink: async ({ email, url }) => {
          if (await isInvited(db, email)) await options.sendMagicLink(email, url);
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
