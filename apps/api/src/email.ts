export type MagicLinkSender = (email: string, url: string) => Promise<void>;

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

/** Sends magic links through Resend's REST API. Plain content, no tracking. */
export function createResendSender(options: {
  apiKey: string;
  from: string;
  fetch?: typeof fetch;
}): MagicLinkSender {
  const fetchImpl = options.fetch ?? fetch;
  return async (email, url) => {
    const link = escape(url);
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: options.from,
        to: [email],
        subject: "Your sign-in link for Grounded",
        text: `Sign in to Grounded with this link:\n\n${url}\n\nIt works once and expires soon. If you didn't ask for it, ignore this email.`,
        html: `<p>Sign in to Grounded:</p><p><a href="${link}">Sign in</a></p><p style="color:#777;font-size:13px">The link works once and expires soon. If you didn't ask for it, ignore this email.</p>`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(
        `Resend refused the email (${String(response.status)}): ${body.message ?? "no details"}`,
      );
    }
  };
}

/**
 * How a magic link reaches the learner. In development the link is printed first, so a refused or
 * spam-filed email never blocks local sign-in; in production it is only emailed. A failed email is
 * logged with its reason and still fails the request.
 */
export function createMagicLinkDelivery(options: {
  email?: MagicLinkSender | undefined;
  printLinks: boolean;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}): MagicLinkSender {
  const log = options.log ?? console.log;
  const logError = options.logError ?? console.error;
  return async (to, url) => {
    if (options.printLinks) log(`\nMagic link for ${to}:\n${url}\n`);
    if (!options.email) return;
    try {
      await options.email(to, url);
    } catch (error) {
      logError(
        `Magic link email to ${to} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  };
}
