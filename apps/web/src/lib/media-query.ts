import { useSyncExternalStore } from "react";

/**
 * Whether a media query matches, kept up to date. Where the browser can't tell (no `matchMedia`, as
 * in tests), `fallback`.
 */
export function useMediaQuery(query: string, fallback: boolean): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => {
        list.removeEventListener("change", onChange);
      };
    },
    () => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : fallback),
    () => fallback,
  );
}

/** The main pointer is a finger (a phone or a tablet), as the CSS `pointer-coarse:` variant says. */
export function isTouchScreen(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}
