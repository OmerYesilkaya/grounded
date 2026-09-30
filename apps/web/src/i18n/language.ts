import { useSyncExternalStore } from "react";

/**
 * The app's language (design §9.3): what the app itself says, never what the tutor teaches in (the
 * teaching language is the track's, inferred from the learner's messages; method.md "Language").
 * English by default. Remembered per browser, like the theme, so the sign-in page already speaks it
 * and nothing waits on the API. `index.html` sets the page's `lang` before the first paint with the
 * same key and rules; keep the two in step.
 */
export const LANGUAGES = ["en", "tr"] as const;
export type Language = (typeof LANGUAGES)[number];

/** Each language in its own words, for the switch. */
export const LANGUAGE_NAMES: Record<Language, string> = { en: "English", tr: "Türkçe" };

export const LANGUAGE_KEY = "grounded:language";

const listeners = new Set<() => void>();

const isLanguage = (value: unknown): value is Language =>
  (LANGUAGES as readonly unknown[]).includes(value);

function storedLanguage(): Language {
  try {
    const value = window.localStorage.getItem(LANGUAGE_KEY);
    return isLanguage(value) ? value : "en";
  } catch {
    // Storage can be blocked (private windows, site data turned off): the default holds.
    return "en";
  }
}

let language: Language = storedLanguage();

function apply() {
  document.documentElement.lang = language;
  for (const listener of listeners) listener();
}

export function setLanguage(next: Language) {
  language = next;
  try {
    window.localStorage.setItem(LANGUAGE_KEY, next);
  } catch {
    // Not remembered, but still used for this visit.
  }
  apply();
}

/** The language now, for what words things outside React (an API failure's message). */
export const currentLanguage = (): Language => language;

let watching = false;

function subscribe(listener: () => void) {
  if (!watching) {
    watching = true;
    // A choice made in another tab is taken up.
    window.addEventListener("storage", (event) => {
      if (event.key !== LANGUAGE_KEY) return;
      language = storedLanguage();
      apply();
    });
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLanguage(): Language {
  return useSyncExternalStore(
    subscribe,
    () => language,
    () => "en" as const,
  );
}

// index.html has set it already; this keeps the page right should that script not have run.
apply();
