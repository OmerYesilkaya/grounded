import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";

/** The steady reading pace, in characters per second. */
const PACE_CPS = 90;
/** However far behind, the text on screen catches up with what has arrived within this long. */
const CATCH_UP_MS = 1500;
/** Once the message is done, the rest appears within this long. */
const FINISH_MS = 300;
/** How long newly revealed text counts as fresh; at least the `reveal` animation in index.css. */
const FADE_MS = 300;

export interface Range {
  start: number;
  end: number;
}

export interface RevealedText {
  /** The part of the text on screen. */
  text: string;
  /** The ranges of `text` revealed in the last moment, contiguous and running to its end. */
  fresh: readonly Range[];
  /** The message is finished and all of it is on screen. */
  done: boolean;
}

/**
 * Paces text that arrives in lumps (the worker batches deltas) so it appears as if written:
 * a steady reading pace, faster when far behind, quick to finish once `streaming` ends. Text that
 * is already there on mount (a snapshot) shows at once, and nothing is paced under reduced motion.
 */
export function useRevealedText(text: string, streaming: boolean): RevealedText {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState<{ count: number; fresh: readonly Range[] }>(() => ({
    count: text.length,
    fresh: [],
  }));
  const pace = useRef({
    progress: text.length,
    count: text.length,
    fresh: [] as (Range & { at: number })[],
  });

  const length = text.length;
  useEffect(() => {
    if (reduced) return;
    const current = pace.current;
    current.progress = Math.min(current.progress, length);
    current.count = Math.min(current.count, length);
    const backlog = length - current.progress;
    if (backlog <= 0 && current.fresh.length === 0) return;
    // Set per arrival, so everything received so far is on screen by the deadline.
    const rate = Math.max(PACE_CPS, (backlog * 1000) / (streaming ? CATCH_UP_MS : FINISH_MS));
    let last = performance.now();
    let frame = requestAnimationFrame(function tick() {
      const now = performance.now();
      current.progress = Math.min(length, current.progress + (rate * (now - last)) / 1000);
      last = now;
      const count = Math.floor(current.progress);
      const settling = current.fresh.filter((range) => now - range.at < FADE_MS);
      if (count > current.count) settling.push({ start: current.count, end: count, at: now });
      if (count !== current.count || settling.length !== current.fresh.length) {
        current.count = count;
        current.fresh = settling;
        setShown({ count, fresh: settling.map(({ start, end }) => ({ start, end })) });
      }
      if (current.progress < length || settling.length > 0) frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [length, streaming, reduced]);

  if (reduced) return { text, fresh: [], done: !streaming };
  const count = Math.min(shown.count, length);
  return {
    text: text.slice(0, count),
    fresh: shown.fresh.filter((range) => range.end <= count),
    done: !streaming && count === length,
  };
}

/**
 * Revealed text: the settled part as one plain text node, and the few fresh ranges each in a span
 * that fades in, so the number of spans stays small however long the text grows.
 */
export function StreamedText({
  revealed,
  className,
}: {
  revealed: RevealedText;
  className?: string;
}) {
  const settled = revealed.fresh[0]?.start ?? revealed.text.length;
  return (
    <p className={cn("whitespace-pre-wrap", className)}>
      {revealed.text.slice(0, settled)}
      {revealed.fresh.map((range) => (
        <span key={range.start} className="motion-safe:animate-reveal">
          {revealed.text.slice(range.start, range.end)}
        </span>
      ))}
    </p>
  );
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeToReducedMotion(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION).matches;
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeToReducedMotion, prefersReducedMotion, () => false);
}
