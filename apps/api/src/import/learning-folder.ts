import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseLedger, type Ledger } from "./ledger.js";

/**
 * A track as the learner's earlier setup kept it (a "Learning" folder): `state.md` written by a model
 * for itself, `handoff.md`, a row in `../README.md`, and one folder per session named
 * `YYYY-MM-DD-topic/` holding `lesson.html`, `homework.md` and `homework-answers.md`.
 */
export interface LearningTrack {
  slug: string;
  /** "How software works" for `how-software-works`. */
  title: string;
  state: string;
  handoff: string | null;
  readmeRow: string | null;
  /** state.md's `## ` sections by heading, bodies trimmed. */
  sections: Map<string, string>;
  /** The `## Ledger` section's terms, parsed. */
  ledger: Ledger;
  /** The newest session folder's lesson. Older lessons are not imported. */
  latestLesson: { folder: string; title: string; html: string } | null;
  /** The newest homework, when it has no answers file: still owed. */
  owedHomework: { folder: string; text: string } | null;
  /** Older homework without an answers file (reported, not imported). */
  otherUnansweredHomework: string[];
  /** The newest session folder's date: the state's "as of". */
  snapshotDate: string | null;
}

const SESSION_FOLDER = /^(\d{4}-\d{2}-\d{2})-/;

export async function readLearningTrack(folder: string): Promise<LearningTrack> {
  const statePath = join(folder, "state.md");
  if (!existsSync(statePath)) throw new Error(`${statePath} doesn't exist: not a track folder.`);
  const state = await readFile(statePath, "utf8");
  const slug = /^# [^\n]*?`([^`\n]+)`/m.exec(state)?.[1] ?? basename(folder);
  const readText = async (path: string) => (existsSync(path) ? await readFile(path, "utf8") : null);

  const sessionFolders = (await readdir(folder, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && SESSION_FOLDER.test(e.name))
    .map((e) => e.name)
    .sort();
  const has = (name: string, file: string) => existsSync(join(folder, name, file));

  const lessonFolder = sessionFolders.findLast((name) => has(name, "lesson.html"));
  const lessonHtml = lessonFolder
    ? await readFile(join(folder, lessonFolder, "lesson.html"), "utf8")
    : null;

  const homeworkFolders = sessionFolders.filter((name) => has(name, "homework.md"));
  const unanswered = homeworkFolders.filter((name) => !has(name, "homework-answers.md"));
  const newestHomework = homeworkFolders.at(-1);
  const owedFolder = newestHomework && unanswered.includes(newestHomework) ? newestHomework : null;

  const newestFolder = sessionFolders.at(-1);
  const sections = sectionsOf(state);
  return {
    slug,
    title: titleFromSlug(slug),
    state,
    handoff: await readText(join(folder, "handoff.md")),
    readmeRow: readmeRow((await readText(join(dirname(folder), "README.md"))) ?? "", slug),
    sections,
    ledger: parseLedger(
      [...sections].find(([heading]) => heading.toLowerCase().startsWith("ledger"))?.[1] ?? "",
    ),
    latestLesson:
      lessonFolder && lessonHtml !== null
        ? { folder: lessonFolder, title: htmlTitle(lessonHtml) ?? lessonFolder, html: lessonHtml }
        : null,
    owedHomework: owedFolder
      ? {
          folder: owedFolder,
          text: await readFile(join(folder, owedFolder, "homework.md"), "utf8"),
        }
      : null,
    otherUnansweredHomework: unanswered.filter((name) => name !== owedFolder),
    snapshotDate: newestFolder ? (SESSION_FOLDER.exec(newestFolder)?.[1] ?? null) : null,
  };
}

export function titleFromSlug(slug: string): string {
  const words = slug.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Level-2 sections by heading. Lines inside code fences (the map's diagram) are never headings. */
export function sectionsOf(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  let heading: string | null = null;
  let body: string[] = [];
  let fenced = false;
  const flush = () => {
    if (heading !== null) sections.set(heading, body.join("\n").trim());
  };
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const match = fenced ? null : /^## (.+)$/.exec(line);
    if (match?.[1]) {
      flush();
      heading = match[1].trim();
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}

/** The README table row whose first cell names the track. */
export function readmeRow(readme: string, slug: string): string | null {
  return (
    readme
      .split("\n")
      .find((line) => line.startsWith("|") && line.split("|")[1]?.includes(`\`${slug}\``)) ?? null
  );
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

export function htmlTitle(html: string): string | null {
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  if (!raw) return null;
  const title = raw.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e] ?? e).trim();
  return title || null;
}
