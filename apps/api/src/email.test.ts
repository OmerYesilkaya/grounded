import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createMagicLinkDelivery, createResendSender } from "./email.js";
import { captureLogs } from "./log.js";

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

describe("magic link delivery", () => {
  const link = "http://localhost:5173/api/auth/magic-link/verify?token=t0ken";
  const logs = () => {
    const captured = captureLogs();
    onTestFinished(captured.restore);
    return captured;
  };

  it("logs the link in development before emailing it, so a failed email never blocks sign-in", async () => {
    const captured = logs();
    const order: string[] = [];
    const deliver = createMagicLinkDelivery({
      email: (to) => {
        order.push(`email ${to} after ${String(captured.lines.length)} line(s)`);
        return Promise.resolve();
      },
      printLinks: true,
    });
    await deliver("ada@example.com", link);
    expect(order).toEqual(["email ada@example.com after 1 line(s)"]);
    expect(captured.text()).toContain(link);
  });

  it("only emails in production, and never logs the token", async () => {
    const captured = logs();
    const email = vi.fn(() => Promise.resolve());
    const deliver = createMagicLinkDelivery({ email, printLinks: false });
    await deliver("ada@example.com", link);
    expect(email).toHaveBeenCalledWith("ada@example.com", link);
    expect(captured.text()).not.toContain("t0ken");
  });

  it("logs a failed email with the reason, and still fails the request", async () => {
    const captured = logs();
    const deliver = createMagicLinkDelivery({
      email: () =>
        Promise.reject(new Error("Resend refused the email (403): only your own address")),
      printLinks: false,
    });
    await expect(deliver("eve@example.com", link)).rejects.toThrow("Resend refused the email");
    expect(captured.lines).toEqual([
      expect.objectContaining({
        level: "error",
        message: "magic link email failed",
        to: "eve@example.com",
        err: expect.objectContaining({
          message: "Resend refused the email (403): only your own address",
        }) as unknown,
      }),
    ]);
    expect(captured.text()).not.toContain("t0ken");
  });

  it("logs only, when there is no email provider", async () => {
    const captured = logs();
    const deliver = createMagicLinkDelivery({ printLinks: true });
    await deliver("ada@example.com", link);
    expect(captured.text()).toContain(link);
  });
});
