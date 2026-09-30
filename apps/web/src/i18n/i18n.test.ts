import { describe, expect, it } from "vitest";
import { allAreas, LANGUAGES } from ".";

/** Each message's path with what it is: "sidebar.item.phase.plan: string". */
function shape(tree: unknown, path = ""): string[] {
  if (typeof tree === "string") return [`${path}: string`];
  if (typeof tree === "function") return [`${path}: function(${String(tree.length)})`];
  if (typeof tree !== "object" || tree === null) return [`${path}: ${typeof tree}`];
  return Object.entries(tree)
    .flatMap(([key, value]) => shape(value, path ? `${path}.${key}` : key))
    .sort();
}

/** The plain strings, by path. */
function strings(tree: unknown, path = ""): [string, string][] {
  if (typeof tree === "string") return [[path, tree]];
  if (typeof tree !== "object" || tree === null) return [];
  return Object.entries(tree).flatMap(([key, value]) =>
    strings(value, path ? `${path}.${key}` : key),
  );
}

describe("the catalogs", () => {
  // Typecheck holds every language to English's shape; this holds at run time what a cast could
  // slip past it.
  for (const [area, languages] of Object.entries(allAreas))
    for (const language of LANGUAGES.filter((l) => l !== "en"))
      it(`say everything in ${area} in ${language} that they say in English`, () => {
        expect(shape(languages[language])).toEqual(shape(languages.en));
      });

  it("leave no message empty", () => {
    for (const [area, languages] of Object.entries(allAreas))
      for (const language of LANGUAGES)
        for (const [path, text] of strings(languages[language]))
          expect(text.trim(), `${language} ${area}.${path}`).not.toBe("");
  });
});
