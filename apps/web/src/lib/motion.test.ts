import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrollIntoViewThen } from "./motion";

describe("scrollIntoViewThen", () => {
  let y = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) =>
      setTimeout(() => {
        f(performance.now());
      }, 16),
    );
    vi.spyOn(window, "scrollY", "get").mockImplementation(() => y);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    y = 0;
  });

  it("goes on once the page has stopped gliding, not while it moves", () => {
    const target = document.createElement("section");
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    const done = vi.fn();
    scrollIntoViewThen(target, "start", done);
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    // The glide: the page moves for twenty frames.
    for (let frame = 0; frame < 20; frame++) {
      y += 30;
      vi.advanceTimersByTime(16);
    }
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(16 * 8);
    expect(done).toHaveBeenCalledTimes(1);
  });
});
