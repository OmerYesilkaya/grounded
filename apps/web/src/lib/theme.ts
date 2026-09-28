import { useSyncExternalStore } from "react";
import type { Theme } from "@/content/environment";

/**
 * The learner's theme (design §9.3): dark by default, light, or following the system's setting,
 * live. Remembered per browser, so the sign-in page already wears it. `index.html` applies the
 * stored choice before the first paint with the same key and rules; keep the two in step.
 */
export type ThemeChoice = Theme | "system";

export const THEME_KEY = "grounded:theme";
const SYSTEM_LIGHT = "(prefers-color-scheme: light)";

const listeners = new Set<() => void>();

function storedChoice(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    return value === "light" || value === "system" ? value : "dark";
  } catch {
    // Storage can be blocked (private windows, site data turned off): the default holds.
    return "dark";
  }
}

let choice: ThemeChoice = storedChoice();

function systemTheme(): Theme {
  return typeof window.matchMedia === "function" && window.matchMedia(SYSTEM_LIGHT).matches
    ? "light"
    : "dark";
}

function resolved(): Theme {
  return choice === "system" ? systemTheme() : choice;
}

/** Sets the page's theme (index.css reads `data-theme`) and tells whoever draws with it. */
function apply() {
  document.documentElement.dataset.theme = resolved();
  for (const listener of listeners) listener();
}

export function setThemeChoice(next: ThemeChoice) {
  choice = next;
  try {
    window.localStorage.setItem(THEME_KEY, next);
  } catch {
    // Not remembered, but still applied for this visit.
  }
  apply();
}

let watching = false;

/** Follows the system's setting and choices made in other tabs; starts with the first subscriber. */
function watch() {
  if (watching) return;
  watching = true;
  if (typeof window.matchMedia === "function")
    window.matchMedia(SYSTEM_LIGHT).addEventListener("change", () => {
      if (choice === "system") apply();
    });
  window.addEventListener("storage", (event) => {
    if (event.key !== THEME_KEY) return;
    choice = storedChoice();
    apply();
  });
}

function subscribe(listener: () => void) {
  watch();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The choice as made, for the account menu. */
export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(
    subscribe,
    () => choice,
    () => "dark" as const,
  );
}

/** The theme the page is in now, for what draws its own colours (diagrams, charts). */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, resolved, () => "dark" as const);
}

// index.html has set it already; this keeps the page right should that script not have run.
apply();
