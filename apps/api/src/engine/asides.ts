import {
  asideRecord,
  resolved,
  type AsideAnchor,
  type AsideRecord,
  type AsideThread,
  type SessionState,
} from "@grounded/core";
import { parseBlocks, type Block } from "@grounded/content";
import {
  and,
  asc,
  asideMessages,
  asides,
  eq,
  inArray,
  learningSessions,
  lte,
  sessionEvents,
  sql,
  termEvents,
  terms,
  type Db,
} from "@grounded/db";
import { log } from "../log.js";
import { publish } from "./events.js";

/*
 * Asides (design §7.5): questions the learner asks on a passage of the lesson, answered in the
 * margin. Their events, on the session's log:
 *
 *   aside          { id, stepId, anchor, tangent: null, saved: false }   a new aside
 *   aside-message  { id, asideId, role, text, blocks }                     a stored message
 *   aside-delta    { asideId, replyTo, text }                              the answer as it streams
 *   aside-tangent  { asideId, tangent }                                    offered for a future session
 *   aside-saved    { asideId }                                             the learner saved it
 *
 * An aside whose thread ends with the learner's message is waiting for its answer; the answer's text
 * so far is the `aside-delta` events replying to that message. A stored tutor message replaces it.
 */

/** The source of an aside's evidence in term_events. */
export const ASIDE_SOURCE = "aside";

/** The tutor's reply when a question couldn't be answered, so the learner can ask again. */
export const asideFailedText = (reason = "") =>
  `That didn't go through.${reason} Ask again when you're ready.`;

export type AsideRow = typeof asides.$inferSelect;
export type AsideMessageRow = typeof asideMessages.$inferSelect;

export interface LoadedAside extends AsideRow {
  messages: AsideMessageRow[];
}

/** The session's asides with their threads, oldest first. */
export async function loadAsides(db: Db, sessionId: string): Promise<LoadedAside[]> {
  const rows = await db
    .select()
    .from(asides)
    .where(eq(asides.sessionId, sessionId))
    .orderBy(asc(asides.createdAt), asc(asides.id));
  if (rows.length === 0) return [];
  const messages = await db
    .select()
    .from(asideMessages)
    .where(
      inArray(
        asideMessages.asideId,
        rows.map((a) => a.id),
      ),
    )
    .orderBy(asc(asideMessages.createdAt), asc(asideMessages.id));
  return rows.map((aside) => ({
    ...aside,
    messages: messages.filter((m) => m.asideId === aside.id),
  }));
}

/** The session's asides as the prompts see them. */
export const asThreads = (loaded: readonly LoadedAside[]): AsideThread[] =>
  loaded.map((aside) => ({
    stepId: aside.stepId,
    quote: aside.anchor.quote,
    messages: aside.messages.map((m) => ({ role: m.role, text: m.text })),
    saved: aside.savedAt ? aside.tangent : null,
  }));

/** The heading asides go under in the prompts of the calls that hear them. */
export const ASKED_IN_THE_MARGIN = "Questions the learner asked in the margin of the lesson";

/** A lesson step's number: `s3` is step 3. */
export const stepNumber = (stepId: string) => Number(stepId.slice(1)) || 0;

/**
 * The session's asides, for the calls that hear them (design §7.5): the checks (only the steps a
 * check covers), and the homework, the recap, the term sweep and "where you left off", which carry
 * them on to the next session. Null when there are none.
 */
export async function asidesRecord(
  db: Db,
  sessionId: string,
  stepIds?: readonly string[],
): Promise<string | null> {
  const loaded = await loadAsides(db, sessionId);
  const chosen = stepIds ? loaded.filter((a) => stepIds.includes(a.stepId)) : loaded;
  return asideRecord(asThreads(chosen), stepNumber);
}

/** The steps the learner can read: up to the first whose check hasn't landed or been continued past. */
export function openSteps(state: SessionState): Set<string> {
  const open = new Set<string>();
  for (const step of state.lesson.steps) {
    open.add(step.id);
    if (!resolved(state.steps[step.id])) break;
  }
  return open;
}

/** Stores a message in an aside's thread and publishes it. */
export async function recordAsideMessage(
  db: Db,
  sessionId: string,
  asideId: string,
  message: { role: "learner" | "tutor"; text: string; blocks?: Block[] },
): Promise<AsideMessageRow> {
  const blocks =
    message.role === "tutor" ? (message.blocks ?? parseBlocks(message.text).blocks) : null;
  const [row] = await db
    .insert(asideMessages)
    .values({ asideId, role: message.role, text: message.text, blocks })
    .returning();
  if (!row) throw new Error("aside message insert returned nothing");
  await publish(db, sessionId, "aside-message", publicMessage(row));
  return row;
}

/** A message as the browser sees it: the learner's words, or the tutor's validated blocks. */
function publicMessage(m: AsideMessageRow) {
  return {
    id: m.id,
    asideId: m.asideId,
    role: m.role,
    text: m.role === "learner" ? m.text : null,
    blocks: m.blocks,
  };
}

/** Asides whose thread ends with the learner: they are waiting for an answer. */
export const waitingFor = (aside: LoadedAside) => {
  const last = aside.messages.at(-1);
  return last?.role === "learner" ? last : null;
};

/**
 * The session's asides for its snapshot, with the answer written so far (up to the cursor) for
 * those still waiting: the stream resumes after the cursor, so the text before it comes with them.
 */
export async function asidesSnapshot(db: Db, sessionId: string, cursor: number) {
  const loaded = await loadAsides(db, sessionId);
  const waiting = new Map(
    loaded.flatMap((aside) => {
      const question = waitingFor(aside);
      return question ? [[question.id, aside.id] as const] : [];
    }),
  );
  const drafts = new Map<string, string>();
  if (waiting.size > 0) {
    const deltas = await db
      .select({ data: sessionEvents.data })
      .from(sessionEvents)
      .where(
        and(
          eq(sessionEvents.sessionId, sessionId),
          lte(sessionEvents.id, cursor),
          eq(sessionEvents.type, "aside-delta"),
          inArray(sql<string>`${sessionEvents.data}->>'replyTo'`, [...waiting.keys()]),
        ),
      )
      .orderBy(asc(sessionEvents.id));
    for (const { data } of deltas) {
      const delta = data as { asideId: string; text: string };
      drafts.set(delta.asideId, (drafts.get(delta.asideId) ?? "") + delta.text);
    }
  }
  return loaded.map((aside) => ({
    id: aside.id,
    stepId: aside.stepId,
    anchor: aside.anchor,
    tangent: aside.tangent,
    saved: aside.savedAt !== null,
    messages: aside.messages.map(publicMessage),
    draft: drafts.get(aside.id) ?? null,
  }));
}

/** Whether the learner has ever asked in the margin: until then, the lesson shows how (design §9.1). */
export async function hasAskedAside(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: asides.id })
    .from(asides)
    .innerJoin(learningSessions, eq(learningSessions.id, asides.sessionId))
    .where(eq(learningSessions.userId, userId))
    .limit(1);
  return row !== undefined;
}

/** Creates an aside with the learner's first question and publishes both. */
export async function createAside(
  db: Db,
  sessionId: string,
  input: { stepId: string; anchor: AsideAnchor; question: string },
): Promise<{ aside: AsideRow; question: AsideMessageRow }> {
  const [aside] = await db
    .insert(asides)
    .values({ sessionId, stepId: input.stepId, anchor: input.anchor })
    .returning();
  if (!aside) throw new Error("aside insert returned nothing");
  await publish(db, sessionId, "aside", {
    id: aside.id,
    stepId: aside.stepId,
    anchor: aside.anchor,
    tangent: null,
    saved: false,
  });
  const question = await recordAsideMessage(db, sessionId, aside.id, {
    role: "learner",
    text: input.question,
  });
  return { aside, question };
}

/**
 * Keeps what an aside's question showed about the track's terms as term_events with source "aside"
 * (design §7.5). An aside never changes a status (method.md), so each event records the term's
 * status as it is, from and to; the checks, the close's sweep and the next session weigh it. Terms
 * not on the list are left out (logged). Returns how many were kept.
 */
export async function recordAsideEvidence(
  db: Db,
  trackId: string,
  evidence: AsideRecord["evidence"],
): Promise<number> {
  const rows = await db
    .select({ id: terms.id, term: terms.term })
    .from(terms)
    .where(eq(terms.trackId, trackId));
  const idOf = new Map(rows.map((r) => [r.term.trim().toLowerCase(), r.id]));
  let kept = 0;
  let unknown = 0;
  for (const item of evidence) {
    const termId = idOf.get(item.term.trim().toLowerCase());
    if (!termId || !item.evidence.trim()) {
      unknown++;
      continue;
    }
    await db.transaction(async (tx) => {
      // The status as it is when the event is written, held until it is: a check changing it at
      // the same moment comes before or after, never in between.
      const [term] = await tx
        .select({ status: terms.status })
        .from(terms)
        .where(eq(terms.id, termId))
        .for("update");
      if (!term) return;
      await tx.insert(termEvents).values({
        termId,
        fromStatus: term.status,
        toStatus: term.status,
        evidence: item.evidence.trim(),
        source: ASIDE_SOURCE,
      });
      kept++;
    });
  }
  if (unknown > 0) log.info({ unknown }, "aside evidence named terms not on the list; left out");
  return kept;
}
