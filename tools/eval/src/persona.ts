import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";

/** A scripted learner: the sheet the learner model plays and the judge reads as the truth. */
export interface Persona {
  id: string;
  /** What they type as the track's goal. */
  goal: string;
  language: string;
  /** The whole sheet: who they are, what they know, don't know and believe wrongly, how they act. */
  sheet: string;
}

export const PERSONAS_DIR = new URL("./personas/", import.meta.url);

export function parsePersona(id: string, sheet: string): Persona {
  const goal = /^Goal: (.+)$/m.exec(sheet)?.[1]?.trim();
  const language = /^Language: (.+)$/m.exec(sheet)?.[1]?.trim();
  if (!goal || !language) throw new Error(`persona "${id}" needs a "Goal:" and a "Language:" line`);
  return { id, goal, language, sheet };
}

export function loadPersona(id: string): Persona {
  return parsePersona(id, readFileSync(new URL(`${id}.md`, PERSONAS_DIR), "utf8"));
}

export function personaIds(): string[] {
  return readdirSync(PERSONAS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => basename(f, ".md"))
    .sort();
}
