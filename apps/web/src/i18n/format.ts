import type { Language } from "./language";

/**
 * Dates, numbers and money in the app's language (design §9.3), never the browser's locale: a page
 * in English writes "30 September" as English does wherever it is read, and one in Turkish
 * "30 Eylül". Times stay in the browser's own time zone.
 */
export interface Formats {
  /** The BCP 47 tag the `Intl` formats use, and what `toLocale…` calls take. */
  locale: string;
  date(value: Date | string | number, options: Intl.DateTimeFormatOptions): string;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  /** "a, b and c" / "a, b ve c". */
  list(items: readonly string[]): string;
}

const LOCALES: Record<Language, string> = { en: "en", tr: "tr" };

const cache = new Map<Language, Formats>();

export function formatsFor(language: Language): Formats {
  let formats = cache.get(language);
  if (formats) return formats;
  const locale = LOCALES[language];
  const lists = new Intl.ListFormat(locale, { style: "long", type: "conjunction" });
  formats = {
    locale,
    date: (value, options) => new Date(value).toLocaleString(locale, options),
    number: (value, options) => new Intl.NumberFormat(locale, options).format(value),
    list: (items) => lists.format(items),
  };
  cache.set(language, formats);
  return formats;
}
