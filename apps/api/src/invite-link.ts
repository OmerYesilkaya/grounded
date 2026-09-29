import type { Db } from "@grounded/db";
import { invite, normalizeEmail } from "./allowlist.js";
import { createAuth } from "./auth.js";

/** An invite link is handed over by whatever channel, so it lives longer than an emailed one. */
export const INVITE_LINK_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

/**
 * Invites the email and mints a sign-in link to hand over without email: it works once, for a week,
 * and signs in whoever opens it, so it goes over a private channel. The link comes from the
 * magic-link endpoint itself, so its token is stored exactly the way the verify endpoint expects.
 */
export async function createInviteLink(options: {
  db: Db;
  email: string;
  appUrl: string;
  secret: string;
}): Promise<string> {
  const email = normalizeEmail(options.email);
  await invite(options.db, email);
  let link: string | undefined;
  const auth = createAuth({
    db: options.db,
    baseURL: options.appUrl,
    secret: options.secret,
    trustedOrigins: [options.appUrl],
    sendMagicLink: (_to, url) => {
      link = url;
    },
    rateLimit: false,
    magicLinkExpiresIn: INVITE_LINK_LIFETIME_SECONDS,
  });
  await auth.api.signInMagicLink({ body: { email, callbackURL: "/" }, headers: new Headers() });
  if (!link) throw new Error(`no invite link was minted for ${email}`);
  return link;
}
