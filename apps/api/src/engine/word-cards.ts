import { resolved, type SessionState, type TrackAction } from "@grounded/core";
import { cardNames, wordCards } from "@grounded/content";
import { and, eq, inArray, lessons, terms, type Db } from "@grounded/db";
import { log } from "../log.js";
import { loadSession } from "./session-store.js";
import { applyValidActions } from "./track-state.js";

/**
 * A word card marks its term taught (design §6.2), once the learner can read its step: the step is
 * written, and every check before it landed or was continued past. Only a term still `planned`
 * moves; one taught again keeps its status, and nothing held is touched. Its evidence is the card
 * itself. Safe to run again: a term it marked is no longer planned. Run after a step is written and
 * after a check or a "continue" opens the steps behind it.
 */
export async function markCardsTaught(db: Db, sessionId: string, state?: SessionState) {
  const session = await loadSession(db, sessionId);
  const current = state ?? session.state;
  const info = current.lesson;
  const [lesson] = await db.select().from(lessons).where(eq(lessons.sessionId, sessionId));
  if (!lesson?.outline) return;
  // Readable: every step up to the first one whose check isn't resolved, that one included.
  const open = info.steps.findIndex((s) => !resolved(current.steps[s.id]));
  const readable = new Set(
    info.steps.slice(0, open === -1 ? undefined : open + 1).map((s) => s.id),
  );

  const given: { term: string; stepId: string; text: string }[] = [];
  lesson.steps.forEach((step) => {
    if (!readable.has(step.id)) return;
    const index = info.steps.findIndex((s) => s.id === step.id);
    const cards = wordCards([...step.body]);
    for (const term of lesson.outline?.steps[index]?.introduces ?? []) {
      const card = cards.find((c) => cardNames(c.term, term));
      if (card) given.push({ term, stepId: step.id, text: card.text });
    }
  });
  if (given.length === 0) return;

  const planned = await db
    .select({ term: terms.term })
    .from(terms)
    .where(
      and(
        eq(terms.trackId, session.trackId),
        eq(terms.status, "planned"),
        inArray(
          terms.term,
          given.map((g) => g.term),
        ),
      ),
    );
  const still = new Set(planned.map((p) => p.term));
  for (const stepId of new Set(given.map((g) => g.stepId))) {
    const actions: TrackAction[] = given
      .filter((g) => g.stepId === stepId && still.has(g.term))
      .map((g) => ({
        type: "set-term-status",
        term: g.term,
        status: "taught",
        evidence: `Given its word card in the lesson: ${g.text}`,
      }));
    if (actions.length === 0) continue;
    const { rejected } = await applyValidActions(db, session.trackId, actions, {
      source: `lesson ${stepId}`,
    });
    log.info({ stepId, taught: actions.length - rejected.length }, "word cards marked taught");
  }
}
