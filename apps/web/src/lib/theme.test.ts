import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The system's colour scheme, which the test flips as a learner changing their OS setting would. */
function fakeSystem(light: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    get matches() {
      return light;
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => query),
  );
  return {
    set(next: boolean) {
      light = next;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

/** The module as a fresh page load finds it. */
const load = async () => {
  vi.resetModules();
  return import("./theme");
};
const pageTheme = () => document.documentElement.dataset.theme;

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the theme", () => {
  it("is dark by default, even when the system is light", async () => {
    fakeSystem(true);
    const theme = await load();
    expect(pageTheme()).toBe("dark");
    expect(renderHook(() => theme.useThemeChoice()).result.current).toBe("dark");
  });

  it("is remembered in this browser", async () => {
    fakeSystem(false);
    const first = await load();
    act(() => {
      first.setThemeChoice("light");
    });
    expect(pageTheme()).toBe("light");

    delete document.documentElement.dataset.theme;
    const next = await load();
    expect(pageTheme()).toBe("light");
    expect(renderHook(() => next.useThemeChoice()).result.current).toBe("light");
  });

  it("follows the system live, and stops when a theme is chosen", async () => {
    const system = fakeSystem(false);
    const theme = await load();
    const { result } = renderHook(() => theme.useTheme());
    act(() => {
      theme.setThemeChoice("system");
    });
    expect(result.current).toBe("dark");

    system.set(true);
    expect(result.current).toBe("light");
    expect(pageTheme()).toBe("light");

    act(() => {
      theme.setThemeChoice("dark");
    });
    system.set(false);
    system.set(true);
    expect(result.current).toBe("dark");
    expect(pageTheme()).toBe("dark");
  });

  it("takes up a choice made in another tab", async () => {
    fakeSystem(false);
    const theme = await load();
    const { result } = renderHook(() => theme.useThemeChoice());
    localStorage.setItem(theme.THEME_KEY, "light");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: theme.THEME_KEY }));
    });
    expect(result.current).toBe("light");
    expect(pageTheme()).toBe("light");
  });
});
