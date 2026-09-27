import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamedText, useRevealedText } from "./streamed-text";

const words = (n: number) => "word ".repeat(n / 5).slice(0, n);

function reveal(text: string, streaming: boolean) {
  return renderHook(
    (props: { text: string; streaming: boolean }) => useRevealedText(props.text, props.streaming),
    {
      initialProps: { text, streaming },
    },
  );
}

const advance = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useRevealedText", () => {
  it("reveals streamed text progressively, at a reading pace", () => {
    const hook = reveal("", true);
    const text = words(100);
    hook.rerender({ text, streaming: true });
    expect(hook.result.current.text).toBe("");

    advance(500);
    const shown = hook.result.current.text.length;
    expect(shown).toBeGreaterThanOrEqual(30);
    expect(shown).toBeLessThanOrEqual(60);
    expect(text.startsWith(hook.result.current.text)).toBe(true);
    expect(hook.result.current.done).toBe(false);

    advance(1000);
    expect(hook.result.current.text.length).toBeGreaterThan(shown);
  });

  it("catches up within about a second and a half when far behind", () => {
    const hook = reveal("", true);
    const text = words(2000);
    hook.rerender({ text, streaming: true });

    advance(750);
    expect(hook.result.current.text.length).toBeGreaterThan(500);
    expect(hook.result.current.text.length).toBeLessThan(2000);
    advance(800);
    expect(hook.result.current.text).toBe(text);
    expect(hook.result.current.done).toBe(false);
  });

  it("keeps up with text that keeps arriving", () => {
    const hook = reveal("", true);
    let text = "";
    for (let i = 0; i < 20; i++) {
      text += words(400);
      hook.rerender({ text, streaming: true });
      advance(80);
    }
    advance(1600);
    expect(hook.result.current.text).toBe(text);
  });

  it("finishes promptly once the message is done", () => {
    const hook = reveal("", true);
    const text = words(1000);
    hook.rerender({ text, streaming: true });
    advance(100);
    hook.rerender({ text, streaming: false });
    expect(hook.result.current.done).toBe(false);

    advance(400);
    expect(hook.result.current.text).toBe(text);
    expect(hook.result.current.done).toBe(true);
  });

  it("shows a message that was already finished at once", () => {
    const text = words(1000);
    const hook = reveal(text, false);
    expect(hook.result.current).toEqual({ text, fresh: [], done: true });
  });

  it("shows what had already arrived at once, and paces only what comes after", () => {
    const hook = reveal(words(300), true);
    expect(hook.result.current.text).toBe(words(300));

    hook.rerender({ text: words(600), streaming: true });
    expect(hook.result.current.text).toBe(words(300));
    advance(300);
    expect(hook.result.current.text.length).toBeGreaterThan(300);
    expect(hook.result.current.text.length).toBeLessThan(600);
  });

  it("shows everything immediately under reduced motion", () => {
    preferReducedMotion(true);
    const hook = reveal("", true);
    const text = words(1000);
    hook.rerender({ text, streaming: true });
    expect(hook.result.current).toEqual({ text, fresh: [], done: false });
    hook.rerender({ text, streaming: false });
    expect(hook.result.current.done).toBe(true);
  });

  it("marks the newest text as fresh for a moment, then settles it", () => {
    preferReducedMotion(false);
    const hook = reveal("", true);
    const text = words(400);
    hook.rerender({ text, streaming: true });
    advance(200);
    const { fresh, text: shown } = hook.result.current;
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.at(-1)?.end).toBe(shown.length);
    fresh.slice(1).forEach((range, i) => {
      expect(range.start).toBe(fresh[i]?.end);
    });

    advance(3000);
    expect(hook.result.current.text).toBe(text);
    expect(hook.result.current.fresh).toEqual([]);
  });
});

describe("StreamedText", () => {
  it("renders the settled text plainly and each fresh range in its own fading span", () => {
    const { container } = render(
      <StreamedText
        revealed={{
          text: "Hello there, reader",
          fresh: [
            { start: 5, end: 12 },
            { start: 12, end: 19 },
          ],
          done: false,
        }}
      />,
    );
    const paragraph = container.querySelector("p");
    expect(paragraph).toHaveTextContent("Hello there, reader");
    expect([...(paragraph?.querySelectorAll("span") ?? [])].map((s) => s.textContent)).toEqual([
      " there,",
      " reader",
    ]);
  });
});
