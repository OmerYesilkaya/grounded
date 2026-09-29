import { useSyncExternalStore } from "react";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeToReducedMotion(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
}

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION).matches;
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeToReducedMotion, prefersReducedMotion, () => false);
}

/** A glide, or a jump for readers who asked for reduced motion. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "instant" : "smooth";
}

/** Frames without movement that mean the page has stopped (a glide may take a frame to start). */
const STILL_FRAMES = 6;
/** However long a glide takes, what waits for it goes on after this. */
const LONGEST_GLIDE_MS = 1500;

/**
 * Brings an element into view, then calls `done` once the page has stopped moving. What `done`
 * opens (a sheet over the foot of a phone's screen) then can't cut the glide short, as opening it
 * at once did. Measured frame by frame, since not every browser fires `scrollend`.
 */
export function scrollIntoViewThen(
  target: Element,
  block: ScrollLogicalPosition,
  done: () => void,
): void {
  const started = performance.now();
  let last = window.scrollY;
  let still = 0;
  const watch = () => {
    const y = window.scrollY;
    still = y === last ? still + 1 : 0;
    last = y;
    if (still >= STILL_FRAMES || performance.now() - started > LONGEST_GLIDE_MS) done();
    else requestAnimationFrame(watch);
  };
  target.scrollIntoView({ behavior: scrollBehavior(), block });
  requestAnimationFrame(watch);
}
