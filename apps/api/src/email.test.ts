import { describe, expect, it, vi } from "vitest";
import { createResendSender } from "./email.js";

const LINK = "https://app.example.org/api/auth/magic-link/verify?token=abc&callbackURL=%2F";

const replying = (status: number, body: unknown) =>
  vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(body), { status })));

describe("magic link email", () => {
  it("sends the link through Resend with the key in the header", async () => {
    const resend = replying(200, { id: "email-1" });
    const send = createResendSender({
      apiKey: "re_test_123",
      from: "Grounded <hello@example.org>",
      fetch: resend,
    });
    await send("ada@example.com", LINK);

    const [url, init] = resend.mock.calls[0] ?? [];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer re_test_123");
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: "Grounded <hello@example.org>",
      to: ["ada@example.com"],
      subject: "Your sign-in link for Grounded",
    });
    expect(body.text).toContain(LINK);
    expect(body.html).toContain(`href="${LINK.replace("&", "&amp;")}"`);
  });

  it("fails loudly when Resend refuses, without echoing the key", async () => {
    const refusing = replying(403, {
      message: "You can only send testing emails to your own email address",
    });
    const send = createResendSender({
      apiKey: "re_test_123",
      from: "Grounded <onboarding@resend.dev>",
      fetch: refusing,
    });

    const failure: unknown = await send("eve@example.com", "https://x.test").catch(
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(Error);
    const { message } = failure as Error;
    expect(message).toBe(
      "Resend refused the email (403): You can only send testing emails to your own email address",
    );
    expect(message).not.toContain("re_test_123");
  });
});
