import type { Shape } from "./define";
import { formatsFor, type Formats } from "./format";
import { currentLanguage, useLanguage, type Language } from "./language";
import { account } from "./messages/account";
import { common } from "./messages/common";
import { homework } from "./messages/homework";
import { lesson } from "./messages/lesson";
import { notices } from "./messages/notices";
import { session } from "./messages/session";
import { sidebar } from "./messages/sidebar";
import { track } from "./messages/track";

/*
 * Everything the app says, by area, in every language (design §9.3). Each area keeps its languages
 * side by side (`defineMessages`), so a string missing from one fails typecheck; `i18n.test.ts`
 * checks the same at run time.
 */
const AREAS = { common, account, sidebar, track, session, lesson, homework, notices };

type Areas = typeof AREAS;
export type Messages = { [A in keyof Areas]: Shape<Areas[A]["en"]> };

const catalogs = new Map<Language, Messages>();

/** The whole catalog in one language. */
export function messagesFor(language: Language): Messages {
  let messages = catalogs.get(language);
  if (!messages) {
    messages = Object.fromEntries(
      Object.entries(AREAS).map(([area, languages]) => [area, languages[language]]),
    ) as Messages;
    catalogs.set(language, messages);
  }
  return messages;
}

/** Every area in every language, for the test that their keys match. */
export const allAreas = AREAS;

/** What the app says, in the language now chosen; re-renders when it changes. */
export function useT(): Messages {
  return messagesFor(useLanguage());
}

/** Dates and numbers in the language now chosen. */
export function useFormat(): Formats {
  return formatsFor(useLanguage());
}

/** The catalog outside React, in the language now (an API failure's message is worded so). */
export const currentMessages = (): Messages => messagesFor(currentLanguage());
export const currentFormats = (): Formats => formatsFor(currentLanguage());

export { LANGUAGE_NAMES, LANGUAGES, setLanguage, useLanguage, type Language } from "./language";
export type { Formats } from "./format";
