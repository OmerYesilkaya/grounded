import type { Notice } from "@grounded/core/notices";
import { describe, expect, it } from "vitest";
import { messagesFor } from ".";
import { wordNotice } from "./notice";

const en = messagesFor("en");
const tr = messagesFor("tr");

describe("what the API says", () => {
  it("is worded in the app's language", () => {
    const paused: Notice = { code: "pause-or-continue-first" };
    expect(wordNotice(paused, en)).toBe("Choose to pause or continue first.");
    expect(wordNotice(paused, tr)).toBe("Önce ara vermeyi ya da devam etmeyi seç.");
  });

  it("names the provider and says what to do", () => {
    const rejected: Notice = { code: "provider-failed", kind: "invalid-key", provider: "OpenAI" };
    expect(wordNotice(rejected, en)).toBe(
      "Your OpenAI key was rejected. Check it in Settings, or create a new one on OpenAI's site.",
    );
    expect(wordNotice(rejected, tr)).toContain("OpenAI anahtarın reddedildi.");
  });

  it("writes numbers in the app's language", () => {
    const long: Notice = {
      code: "attachment-too-long",
      name: "book.txt",
      characters: 50_001,
      max: 50_000,
    };
    expect(wordNotice(long, en)).toBe(
      "book.txt has 50,001 characters of text; at most 50,000 can be attached.",
    );
    expect(wordNotice(long, tr)).toContain("50.001 karakter");
  });

  it("says a failure in a thread with its cause, and what to do next", () => {
    const failed: Notice = {
      code: "thread-failed",
      thread: "check",
      cause: { code: "no-credential" },
    };
    expect(wordNotice(failed, en)).toBe(
      "That didn't go through. Add your AI key in Settings first. Answer again when you're ready.",
    );
    expect(wordNotice(failed, tr)).toBe(
      "Bu sefer olmadı. Önce Ayarlar'dan yapay zekâ anahtarını ekle. Hazır olduğunda bir daha cevapla.",
    );
  });

  it("shows words stored before notices as they are, and a code it doesn't know as a failure", () => {
    expect(wordNotice("Your OpenAI account is out of credit.", tr)).toBe(
      "Your OpenAI account is out of credit.",
    );
    expect(wordNotice({ code: "something-new" } as unknown as Notice, tr)).toBe(tr.common.failed);
  });
});
