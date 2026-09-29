import { finalStanding, type FinalStanding, type TeachBackBreak } from "@grounded/core";
import {
  and,
  asc,
  desc,
  eq,
  fixListItems,
  learningSessions,
  sql,
  terms,
  tracks,
  type Db,
} from "@grounded/db";
import { openExamsOf } from "./arc-exams.js";

/*
 * The final (design §7.4, method.md "The final"): the session a track ends with, once its plan is
 * taught through and its arc exams are in. It opens with the review when something waits for it,
 * then runs a fresh audit, whose misconceptions are the new fix-list, and a teach-back, where the
 * tutor is a skeptical friend asking only why and what if; its close compares the two fix-lists
 * and shows where the chain of reasoning broke. No plan, lesson or homework.
 */

/** Where the track stands towards its final (finalStanding), from the database. */
export async function trackFinalStanding(db: Db, trackId: string): Promise<FinalStanding> {
  const [track] = await db.select({ plan: tracks.plan }).from(tracks).where(eq(tracks.id, trackId));
  const planned = await db
    .select({ term: terms.term })
    .from(terms)
    .where(and(eq(terms.trackId, trackId), eq(terms.status, "planned")));
  const [latest] = await db
    .select({ kind: learningSessions.kind, closedAt: learningSessions.closedAt })
    .from(learningSessions)
    .where(eq(learningSessions.trackId, trackId))
    .orderBy(desc(learningSessions.createdAt), desc(learningSessions.id))
    .limit(1);
  return finalStanding({
    arcs: track?.plan.arcs ?? [],
    planned: planned.map((p) => p.term),
    examsOpen: (await openExamsOf(db, trackId)).length,
    latest: latest ? { final: latest.kind === "final", closed: latest.closedAt !== null } : null,
  });
}

/** A fix-list item as the final's end shows it: open, or closed (fixed). */
export interface FixListEntry {
  text: string;
  open: boolean;
}

/**
 * What a final found (method.md, "The final": "the difference between the two lists is the
 * measurement"): the fix-list the track kept before it, each item as it stands now; the one its
 * fresh audit found; and where the teach-back's chain of reasoning broke.
 */
export interface FinalOutcome {
  before: FixListEntry[];
  found: FixListEntry[];
  breaks: TeachBackBreak[];
}

/**
 * The final's outcome. The new fix-list is the items opened since the final began, by time: a
 * track's sessions never overlap, and the audit's calls don't see the list kept before it.
 */
export async function finalOutcome(
  db: Db,
  session: { id: string; trackId: string; teachBackBreaks: TeachBackBreak[] },
): Promise<FinalOutcome> {
  // Compared in the database, at its precision: a JavaScript Date keeps only milliseconds.
  const began = sql`(select ${learningSessions.createdAt} from ${learningSessions} where ${learningSessions.id} = ${session.id})`;
  const items = await db
    .select({
      text: fixListItems.text,
      status: fixListItems.status,
      before: sql<boolean>`${fixListItems.createdAt} < ${began}`,
    })
    .from(fixListItems)
    .where(eq(fixListItems.trackId, session.trackId))
    .orderBy(asc(fixListItems.createdAt), asc(fixListItems.id));
  const entry = (item: (typeof items)[number]) => ({
    text: item.text,
    open: item.status === "open",
  });
  return {
    before: items.filter((i) => i.before).map(entry),
    found: items.filter((i) => !i.before).map(entry),
    breaks: session.teachBackBreaks,
  };
}

/** Adds the teach-back's newly marked breaks to its session. */
export async function recordBreaks(db: Db, sessionId: string, breaks: readonly TeachBackBreak[]) {
  if (breaks.length === 0) return;
  await db
    .update(learningSessions)
    .set({
      teachBackBreaks: sql`${learningSessions.teachBackBreaks} || ${JSON.stringify(breaks)}::jsonb`,
    })
    .where(eq(learningSessions.id, sessionId));
}

/** The heading the final's outcome goes under in its close's calls. */
export const FINAL_FOUND = "What the final found (the learner sees both lists beside the recap)";

/** The final's outcome in words, for its close's calls. */
export function finalRecord(outcome: FinalOutcome): string {
  const line = (item: FixListEntry) => `- [${item.open ? "open" : "closed"}] ${item.text}`;
  const breaks = outcome.breaks.map((b) => `- ${b.term ? `In ${b.term}: ` : ""}“${b.quote}”`);
  return [
    "The fix-list the track kept before the final, each item as it stands now:",
    outcome.before.length ? outcome.before.map(line).join("\n") : "(none)",
    "The fix-list the final's fresh audit found:",
    outcome.found.length ? outcome.found.map(line).join("\n") : "(none: it found no misconception)",
    "Where the chain of reasoning broke in the teach-back, in the learner's words:",
    breaks.length ? breaks.join("\n") : "(nowhere marked)",
  ].join("\n\n");
}

/** The most answers each part of the final takes, however the decisions go. */
export const FINAL_ANSWERS = { audit: 12, "teach-back": 20 } as const;

/**
 * What each part of the final is, in every call of it (under its phase's method): the audit is
 * cold, and the teach-back's tutor only asks.
 */
export const FINAL_PART = {
  audit: {
    heading: "This part of the final: the fresh audit",
    body: "Audit the whole subject again cold, as \"The final\" says: the first session's audit in shape, with entirely new questions and no reference to anything asked before, the probe's rules throughout. Its misconceptions are the new fix-list, which the close compares with the one the track kept (you aren't shown that one, so the new list is recorded on its own). One question at a time; teach nothing.",
  },
  "teach-back": {
    heading: "This part of the final: the teach-back",
    body: 'The learner is rebuilding the subject from its foundations in their own words. You are a smart, skeptical friend who only asks "why?" and "what if?": one short question at a time about what they just said, following the chain down to what it rests on, or pushing a claim into a case they haven\'t met. Never explain, correct, confirm or hint; where they have to say "it just is", note it and ask about the next link. The breaks are shown to them at the end.',
  },
} as const;

/** The final's first message: its audit, after the review's last answer if there was one. */
export const auditOpening = (afterReview: boolean) =>
  `(For the app; the learner doesn't see this.) ${afterReview ? "The review is over: acknowledge their last answer in a few neutral words. Then the" : "The"} track's final begins with its audit. The app has already told them what the final is (the audit, then the teach-back, and no homework), so don't explain it again: at most a few words, then the first audit question.`;

export const AUDIT_DECISION_PROMPT =
  "(For the app; the learner doesn't see this.) Record what the learner's answers in the audit showed that isn't recorded yet: every misconception as a new fix-list item, in plain words, and term statuses from how they used the terms. Then say whether the audit is finished: every strand of the subject audited, well enough to compare with where they started, or they asked to move on. If it is, you won't write another audit question: the teach-back comes next.";

export const TEACH_BACK_OPENING_PROMPT =
  '(For the app; the learner doesn\'t see this.) The audit is over. Acknowledge their last answer in a few neutral words, then open the teach-back: ask them to rebuild the subject from its foundations in their own words, starting wherever they think it starts, as if for a smart friend who wasn\'t there, and say you will keep asking "why?" and "what if?".';

export const TEACH_BACK_DECISION_PROMPT =
  "(For the app; the learner doesn't see this.) Record what the learner's latest answer in the teach-back showed that isn't recorded yet: the terms they rebuilt from what they rest on, and each place the chain broke, where they had to say \"it just is\" or gave no reason when asked why, in their exact words. Then say whether the teach-back is finished: they have rebuilt the subject from its foundations as far as they can, or asked to finish. If it is, you won't write another question: the close comes next.";

export const FINAL_RECAP_REQUEST = `(Close the final: the recap, as "The final" says. Say how the fresh audit's fix-list compares with the one the track kept (under "${FINAL_FOUND}"): what the arcs fixed and stayed fixed, what is new or came back. Then show them exactly where the chain of reasoning broke in the teach-back: at each place, what they said and what it rests on that they couldn't give. Say that anything on the new list becomes a session of its own. Anchor it to the connections between ideas, and keep it short: the app shows both lists beside your message, so don't list them again.)`;

/** Added to the term sweep's request in a final. */
export const FINAL_SWEEP_REQUEST =
  " This was the track's final: close an earlier fix-list item the fresh audit found no trace of, and keep what the audit found open.";
