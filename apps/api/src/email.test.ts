import { describe, expect, it, vi } from "vitest";
import { createMagicLinkDelivery, createResendSender } from "./email.js";

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
  const link = "http://localhost:5173/api/auth/magic-link/verify?token=t";

  it("prints the link in development before emailing it, so a failed email never blocks sign-in", async () => {
    const lines: string[] = [];
    const order: string[] = [];
    const deliver = createMagicLinkDelivery({
      email: (to) => {
        order.push(`email ${to}`);
        return Promise.resolve();
      },
      printLinks: true,
      log: (line) => {
        lines.push(line);
        order.push("print");
      },
    });
    await deliver("ada@example.com", link);
    expect(order).toEqual(["print", "email ada@example.com"]);
    expect(lines.join("\n")).toContain(link);
  });

  it("only emails in production", async () => {
    const lines: string[] = [];
    const email = vi.fn(() => Promise.resolve());
    const deliver = createMagicLinkDelivery({
      email,
      printLinks: false,
      log: (line) => lines.push(line),
    });
    await deliver("ada@example.com", link);
    expect(email).toHaveBeenCalledWith("ada@example.com", link);
    expect(lines).toEqual([]);
  });

  it("logs a failed email with the reason, and still fails the request", async () => {
    const errors: string[] = [];
    const deliver = createMagicLinkDelivery({
      email: () =>
        Promise.reject(new Error("Resend refused the email (403): only your own address")),
      printLinks: false,
      log: () => undefined,
      logError: (line) => errors.push(line),
    });
    await expect(deliver("eve@example.com", link)).rejects.toThrow("Resend refused the email");
    expect(errors).toEqual([
      "Magic link email to eve@example.com failed: Resend refused the email (403): only your own address",
    ]);
  });

  it("prints only, when there is no email provider", async () => {
    const lines: string[] = [];
    const deliver = createMagicLinkDelivery({ printLinks: true, log: (line) => lines.push(line) });
    await deliver("ada@example.com", link);
    expect(lines.join("\n")).toContain(link);
  });
});
