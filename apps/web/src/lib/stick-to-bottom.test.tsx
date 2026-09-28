import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePage } from "@/test-page";
import { useStickToBottom } from "./stick-to-bottom";

function preferReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: reduce && query === "(prefers-reduced-motion: reduce)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
}

let fake: ReturnType<typeof fakePage>;

beforeEach(() => {
  // A 2000px page in an 800px viewport, scrolled to the bottom.
  fake = fakePage({ height: 2000, viewport: 800, y: 1200 });
  preferReducedMotion(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stick() {
  const content = document.createElement("div");
  const overlay = document.createElement("div");
  const hook = renderHook(() => useStickToBottom({ content, overlay }));
  return { content, overlay, hook };
}

describe("useStickToBottom", () => {
  it("follows the content as it grows while the reader is at the bottom", () => {
    const { content, hook } = stick();
    fake.resize(content, 2300);
    expect(fake.page.y).toBe(1500);
    expect(fake.scrollTo).toHaveBeenLastCalledWith({ top: 2300, behavior: "instant" });
    expect(hook.result.current.following).toBe(true);
  });

  it("follows when the overlay at the bottom grows", () => {
    const { overlay } = stick();
    fake.resize(overlay, 2100);
    expect(fake.page.y).toBe(1300);
  });

  it("still follows a reader just short of the bottom", () => {
    const { content, hook } = stick();
    fake.scroll(1170);
    expect(hook.result.current.following).toBe(true);
    fake.resize(content, 2400);
    expect(fake.page.y).toBe(1600);
  });

  it("leaves a reader who scrolled up where they are", () => {
    const { content, hook } = stick();
    fake.scroll(600);
    expect(hook.result.current.following).toBe(false);
    fake.scrollTo.mockClear();
    fake.resize(content, 2400);
    expect(fake.scrollTo).not.toHaveBeenCalled();
    expect(fake.page.y).toBe(600);
  });

  it("takes hold again when the reader scrolls back down to the bottom", () => {
    const { content, hook } = stick();
    fake.scroll(600);
    fake.scroll(900);
    expect(hook.result.current.following).toBe(false);
    fake.scroll(1190);
    expect(hook.result.current.following).toBe(true);
    fake.resize(content, 2400);
    expect(fake.page.y).toBe(1600);
  });

  it("goes to the bottom and follows again on scrollToBottom, gliding unless motion is reduced", () => {
    const { content, hook } = stick();
    fake.scroll(600);
    act(() => {
      hook.result.current.scrollToBottom({ smooth: true });
    });
    expect(fake.scrollTo).toHaveBeenLastCalledWith({ top: 2000, behavior: "smooth" });
    expect(hook.result.current.following).toBe(true);
    fake.resize(content, 2400);
    expect(fake.page.y).toBe(1600);

    preferReducedMotion(true);
    fake.scroll(600);
    act(() => {
      hook.result.current.scrollToBottom({ smooth: true });
    });
    expect(fake.scrollTo).toHaveBeenLastCalledWith({ top: 2400, behavior: "instant" });
  });

  it("keeps following through a glide's scroll events on the way down", () => {
    const { hook } = stick();
    fake.scroll(200);
    // The glide hasn't moved yet when scrollTo returns; its scroll events come after.
    fake.scrollTo.mockImplementationOnce(() => undefined);
    act(() => {
      hook.result.current.scrollToBottom({ smooth: true });
    });
    fake.scroll(500);
    fake.scroll(900);
    expect(hook.result.current.following).toBe(true);
  });

  it("stops observing on unmount", () => {
    const { content, hook } = stick();
    hook.unmount();
    fake.scrollTo.mockClear();
    fake.resize(content, 2400);
    expect(fake.scrollTo).not.toHaveBeenCalled();
  });
});
