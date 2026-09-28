import { act } from "@testing-library/react";
import { vi } from "vitest";

/** A ResizeObserver whose callbacks run when the test says an element changed size. */
class FakeResizeObserver {
  static all = new Set<FakeResizeObserver>();
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.all.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    FakeResizeObserver.all.delete(this);
  }
}

/**
 * jsdom has no layout, so this stands in for the window's scroll metrics: the page's height, the
 * viewport and `scrollY` are set by hand, `scrollTo` moves `scrollY` (clamped, and firing `scroll`),
 * and a fake ResizeObserver reports the size changes the test makes. Undo with `vi.restoreAllMocks`
 * and `vi.unstubAllGlobals`.
 */
export function fakePage({ height, viewport, y }: { height: number; viewport: number; y: number }) {
  const page = { height, viewport, y };
  const bottom = () => Math.max(0, page.height - page.viewport);
  const fire = () => {
    window.dispatchEvent(new Event("scroll"));
  };

  FakeResizeObserver.all.clear();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    page.y = Math.min(options.top ?? page.y, bottom());
    fire();
  });
  vi.stubGlobal("scrollTo", scrollTo);
  vi.spyOn(window, "scrollY", "get").mockImplementation(() => page.y);
  vi.spyOn(window, "innerHeight", "get").mockImplementation(() => page.viewport);
  vi.spyOn(document.documentElement, "scrollHeight", "get").mockImplementation(() => page.height);

  return {
    page,
    scrollTo,
    /** The reader scrolls to `y`. */
    scroll(y: number) {
      act(() => {
        page.y = y;
        fire();
      });
    },
    /** `target` changes size, making the page `height` tall. */
    resize(target: Element, height: number) {
      act(() => {
        page.height = height;
        for (const observer of FakeResizeObserver.all) {
          if (observer.targets.has(target)) {
            observer.callback([], observer);
          }
        }
      });
    },
  };
}
