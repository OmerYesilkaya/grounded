import type { TrackAction } from "@grounded/core";
import {
  eq,
  learningSessions,
  lessons,
  sessionMessages,
  trackFiles,
  tracks,
  users,
  type Db,
  type TermStatus,
} from "@grounded/db";
import { applyActions } from "../engine/track-state.js";

/*
 * A large track shaped like the one imported from the earlier setup (#13): 204 terms in 12 arcs,
 * with names as long as the real ones (about 76 characters), a shallow map (what a term rests on
 * goes back a few terms, not to the start), 14 fix-list items and about 34 KB of plan notes. Three
 * closed sessions touched a few terms each; the fourth is open.
 */

export const ARCS = 12;
export const TERMS_PER_ARC = 17;
/** The arc the track has reached: its first terms are taught, the rest planned. */
export const CURRENT_ARC = 7;
export const NOTES_LENGTH = 34_000;

const TOPICS = [
  "memory and the working copy",
  "processes and the scheduler",
  "files, disks and the page cache",
  "networks: packets and addresses",
  "TCP: ordering and resending",
  "HTTP requests and responses",
  "databases: rows, pages and the log",
  "transactions and isolation levels",
  "indexes and query plans",
  "caching layers in front of a database",
  "queues and background workers",
  "deploying and observing a service",
];

/** A term's name: long like the imported ones, unique by arc and position. */
export const termName = (arc: number, position: number) =>
  `${TOPICS[arc] ?? "topic"} ${String(position + 1)}: what the learner can say about it in plain words`;

/** What a term rests on: a shallow tree inside its arc, and every second arc leans on the one before. */
function restsOn(arc: number, position: number): string[] {
  if (position > 0) return [termName(arc, Math.floor((position - 1) / 2))];
  return arc > 0 && arc % 2 === 0 ? [termName(arc - 1, 5)] : [];
}

/** Where a term stands when the track is imported. */
function statusOf(arc: number, position: number): TermStatus {
  if (arc < CURRENT_ARC) {
    if (position % 7 === 3) return "taught";
    if (position % 11 === 5) return "assumed";
    return "confirmed";
  }
  if (arc === CURRENT_ARC && position < 9) return position % 3 === 2 ? "taught" : "confirmed";
  return "planned";
}

const sentence = (i: number) =>
  `Session ${String(1 + (i % 30))}: the learner explained step ${String(i)} of the mechanism in their own words, and one part still needs a fresh check next time.`;

/** About NOTES_LENGTH characters of notes, in the imported notes' shape. */
export function planNotes(): string {
  const lines = ["### From the earlier setup (imported)", ""];
  for (let i = 0; lines.join("\n").length < NOTES_LENGTH; i++) {
    if (i % 12 === 0) lines.push("", `#### Session log part ${String(i / 12 + 1)}`, "");
    lines.push(`- ${sentence(i)}`);
  }
  return lines.join("\n").slice(0, NOTES_LENGTH);
}

export const FIX_ITEMS = Array.from(
  { length: 14 },
  (_, i) =>
    `Misconception ${String(i + 1)}: thinks a read that waits for a row being updated is a bug in the database.`,
);

/** The imported track: every term with its status and what it rests on, the arcs, fix-list, notes. */
function importActions(): TrackAction[] {
  const actions: TrackAction[] = [{ type: "set-language", language: "English" }];
  for (let arc = 0; arc < ARCS; arc++) {
    for (let position = 0; position < TERMS_PER_ARC; position++) {
      const term = termName(arc, position);
      actions.push({ type: "add-planned-term", term, restsOn: restsOn(arc, position) });
      const status = statusOf(arc, position);
      if (status !== "planned")
        actions.push({ type: "set-term-status", term, status, evidence: "From the ledger." });
    }
  }
  for (const text of FIX_ITEMS) actions.push({ type: "add-fix-item", text });
  actions.push({
    type: "set-plan",
    arcs: Array.from({ length: ARCS }, (_, arc) => ({
      title: TOPICS[arc] ?? "topic",
      terms: Array.from({ length: TERMS_PER_ARC }, (_, position) => termName(arc, position)),
    })),
    notes: planNotes(),
  });
  return actions;
}

/** Terms the three earlier sessions touched: the current arc's taught ones, and one old re-check. */
export const TOUCHED = [
  [termName(CURRENT_ARC, 2), termName(CURRENT_ARC, 5)],
  [termName(CURRENT_ARC, 8), termName(2, 3)],
  [termName(CURRENT_ARC, 2)],
];

/** "Where you left off" as a close writes it: about 300 words. */
export const LEFT_OFF = Array.from(
  { length: 12 },
  (_, i) =>
    `- ${i % 3 === 0 ? "Open thread" : i % 3 === 1 ? "Owed" : "Re-check"}: ${termName(CURRENT_ARC, i)}, which came up in the last session.`,
).join("\n");

/** A session's chat as long as a normal one: a probe of a dozen exchanges and the plan. */
export const CONVERSATION = Array.from({ length: 24 }, (_, i) => ({
  role: i % 2 === 0 ? ("tutor" as const) : ("learner" as const),
  text:
    i % 2 === 0
      ? `Question ${String(i / 2 + 1)}: ${"What happens to the row while the other transaction holds it, and why? ".repeat(6)}`
      : `Answer ${String((i + 1) / 2)}: ${"I think the read waits because the row is being changed. ".repeat(4)}`,
}));

/** One lesson step's markdown, the size of a real one, for the check's prompt. */
export const STEP_SOURCE = `## Step 3: why the read waits\n\n${"The row is being changed by another transaction, so the read has two choices. ".repeat(40)}\n\n:::check\nWhat would the read see if it didn't wait?\n:::`;

/**
 * Creates the learner, the imported track and its sessions: three closed ones that touched TOUCHED
 * and an open one (its lesson written, one step), with `conversation` as its chat.
 */
/** "What you brought" for a CV, at the length the summary is asked to keep to. */
const BRIEF = Array.from(
  { length: 30 },
  (_, i) =>
    `Line ${String(i + 1)}: built and ran a Node.js service on Postgres for a logistics company, with Redis caching.`,
).join("\n");

export async function createLargeTrack(
  db: Db,
  options: {
    conversation?: readonly { role: "learner" | "tutor"; text: string }[];
    /** "Where you left off", as the last close wrote it; none, as for a track just imported. */
    leftOff?: string;
  } = {},
) {
  const [user] = await db
    .insert(users)
    .values({ name: "Ada", email: "ada@example.com" })
    .returning();
  if (!user) throw new Error("no user");
  const [track] = await db
    .insert(tracks)
    .values({ userId: user.id, title: "How software works", goal: "How software works" })
    .returning();
  if (!track) throw new Error("no track");
  const imported = await applyActions(db, track.id, importActions(), {
    source: "imported from Learning 2026-09-25",
  });
  if (!imported.ok) throw new Error(imported.errors.join("; "));

  const state = {
    phase: "lesson" as const,
    plan: "approved" as const,
    lesson: { status: "ready" as const, steps: [{ id: "s1", restsOnPrevious: false }] },
    steps: { s1: { status: "open" as const, misses: 0, offerGate: false } },
    currentStep: "s1",
  };
  for (const touched of TOUCHED) {
    const [session] = await db
      .insert(learningSessions)
      .values({ trackId: track.id, userId: user.id, state: { ...state, phase: "closed" } })
      .returning();
    if (!session) throw new Error("no session");
    const applied = await applyActions(
      db,
      track.id,
      touched.map((term) => ({
        type: "set-term-status" as const,
        term,
        status: "confirmed" as const,
        evidence: "They used it in their own words.",
      })),
      { source: "close" },
    );
    if (!applied.ok) throw new Error(applied.errors.join("; "));
    await db
      .update(learningSessions)
      .set({ closedAt: new Date() })
      .where(eq(learningSessions.id, session.id));
  }

  if (options.leftOff !== undefined)
    await db.update(tracks).set({ leftOff: options.leftOff }).where(eq(tracks.id, track.id));
  // Files attached at the start, and their summary, which every call of a later session carries
  // (design §4.5): about the 300 words the summary is asked to keep to.
  await db.insert(trackFiles).values({
    trackId: track.id,
    name: "cv.pdf",
    kind: "pdf",
    mediaType: "application/pdf",
    sizeBytes: 180_000,
    pages: 2,
    storageKey: `tracks/${track.id}/cv`,
  });
  await db.update(tracks).set({ brief: BRIEF }).where(eq(tracks.id, track.id));
  const [session] = await db
    .insert(learningSessions)
    .values({ trackId: track.id, userId: user.id, state })
    .returning();
  if (!session) throw new Error("no session");
  await db.insert(lessons).values({ sessionId: session.id, stepSources: { s1: STEP_SOURCE } });
  for (const message of options.conversation ?? []) {
    await db.insert(sessionMessages).values({ sessionId: session.id, ...message });
  }
  return { userId: user.id, trackId: track.id, sessionId: session.id };
}
