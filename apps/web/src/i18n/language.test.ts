import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The modules as a fresh page load finds them. */
const load = async () => {
  vi.resetModules();
  return import(".");
};

beforeEach(() => {
  localStorage.clear();
  document.documentElement.lang = "";
});

describe("the app's language", () => {
  it("is English by default", async () => {
    const i18n = await load();
    expect(document.documentElement.lang).toBe("en");
    expect(renderHook(() => i18n.useT()).result.current.account.menu.signOut).toBe("Sign out");
  });

  it("is remembered per browser, for the next page load", async () => {
    const first = await load();
    act(() => {
      first.setLanguage("tr");
    });
    expect(localStorage.getItem("grounded:language")).toBe("tr");
    const next = await load();
    expect(document.documentElement.lang).toBe("tr");
    expect(renderHook(() => next.useT()).result.current.account.menu.signOut).toBe("Çıkış yap");
  });

  it("changes what is on the page at once, dates and numbers too", async () => {
    const i18n = await load();
    const { result } = renderHook(() => ({ t: i18n.useT(), format: i18n.useFormat() }));
    const when = new Date("2026-09-30T12:00:00Z");
    expect(result.current.format.date(when, { day: "numeric", month: "long" })).toBe(
      "September 30",
    );
    act(() => {
      i18n.setLanguage("tr");
    });
    expect(result.current.t.account.menu.language).toBe("Dil");
    expect(result.current.format.date(when, { day: "numeric", month: "long" })).toBe("30 Eylül");
    expect(result.current.format.number(1234.5)).toBe("1.234,5");
  });

  it("takes up a choice made in another tab", async () => {
    const i18n = await load();
    const { result } = renderHook(() => i18n.useLanguage());
    localStorage.setItem("grounded:language", "tr");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "grounded:language" }));
    });
    expect(result.current).toBe("tr");
  });

  it("falls back to English for a value it doesn't know", async () => {
    localStorage.setItem("grounded:language", "xx");
    const i18n = await load();
    expect(renderHook(() => i18n.useLanguage()).result.current).toBe("en");
  });
});
