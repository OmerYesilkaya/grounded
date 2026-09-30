import type { ReactNode } from "react";
import type { Language } from "./language";

/**
 * One area's messages: plain strings, functions for what takes values (a count, a name), or
 * groups of either. A function may return React nodes where a message holds an element (a link, a
 * key cap); everything else is a string.
 */
export interface MessageTree {
  [key: string]: string | ((...args: never[]) => ReactNode) | MessageTree;
}

/** The shape every language's messages must have: English's keys, with any string for a string. */
export type Shape<T> = {
  [K in keyof T]: T[K] extends string
    ? string
    : T[K] extends (...args: infer A) => infer R
      ? (...args: A) => R
      : Shape<T[K]>;
};

/**
 * An area's messages in every language, English first and the others shaped like it: a key missing
 * from one, or one it doesn't have, or a function taking other values, fails typecheck. Kept side by
 * side, so a string is always added (and changed) in every language at once.
 */
export function defineMessages<T extends MessageTree>(
  messages: { en: T } & Record<Exclude<Language, "en">, NoInfer<Shape<T>>>,
): Record<Language, Shape<T>> {
  // English is its own shape; the type only widens its literal strings.
  return messages as unknown as Record<Language, Shape<T>>;
}
