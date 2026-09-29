import type { LanguageModelV4 } from "@ai-sdk/provider";
import { asc, eq, researchNotes, type Db } from "@grounded/db";
import { stepCountIs, streamText, type ModelMessage, type SystemModelMessage, type Tool } from "ai";
import { startActivity, withActivity, type Activity } from "./events.js";

/** Search rounds a research call may take. */
const RESEARCH_STEPS = 6;

export const PLAN_RESEARCH_PROMPT =
  "(For the app; the learner doesn't see this.) Before planning, scope the field with web search: core concepts, real first principles, standard framings, common gotchas and the field's actual terminology. Prefer official docs and primary sources. Reply with research notes for yourself, with their sources.";

export const LESSON_RESEARCH_PROMPT =
  "(For the app; the learner doesn't see this.) Before outlining the lesson for the approved plan, check with web search what it will state that you aren't sure of: names, dates, figures, quotes, definitions, how a mechanism really works, what a source actually says. Search only for those. If you are sure of everything the lesson needs, search nothing and reply only: Nothing to check. Otherwise reply with notes for yourself: each fact as the sources state it, with its source.";

export interface Research {
  /** The model's notes; worth keeping only when it searched. */
  notes: string;
  /** The queries it searched, as the provider reported them. */
  searches: string[];
}

/**
 * A research call (design §4.4): the provider's web search on, in a call of its own, so a search
 * never takes the place of the plan or the outline, and a provider that can't mix its search with
 * other tools (Gemini's) never has to. Each search shows as an activity.
 */
export async function research(options: {
  db: Db;
  sessionId: string;
  model: LanguageModelV4;
  system: SystemModelMessage[];
  messages: ModelMessage[];
  search: Tool;
  request: string;
  /** The activity the whole call shows under: "Researching the subject". */
  label: string;
}): Promise<Research> {
  const { db, sessionId } = options;
  return withActivity(db, sessionId, options.label, async (researching) => {
    const running = new Map<string, Activity>();
    const searched: string[] = [];
    try {
      const reply = streamText({
        model: options.model,
        system: options.system,
        messages: [...options.messages, { role: "user", content: options.request }],
        tools: { web_search: options.search },
        stopWhen: stepCountIs(RESEARCH_STEPS),
      });
      for await (const part of reply.stream) {
        if (part.type === "error") throw part.error;
        if (part.type === "reasoning-delta") await researching.reasoning(part.text);
        if (part.type === "tool-call" && part.toolName === "web_search") {
          const label = searchLabel(searchQuery(part.input));
          running.set(part.toolCallId, await startActivity(db, sessionId, label));
        }
        if (part.type === "tool-result" && part.toolName === "web_search") {
          const searching = running.get(part.toolCallId);
          const query = searchQuery(part.output) ?? searchQuery(part.input);
          searched.push(query ?? "");
          if (query) await searching?.update({ label: searchLabel(query) });
          await searching?.done();
        }
      }
      return { notes: (await reply.text).trim(), searches: searched };
    } finally {
      for (const searching of running.values()) await searching.done();
    }
  });
}

/** Keeps research on the track (design §4.4), when it searched: notes without a search are memory. */
export async function storeResearch(
  db: Db,
  ids: { trackId: string; sessionId: string },
  kind: "plan" | "lesson",
  found: Research,
): Promise<void> {
  if (found.searches.length === 0 || !found.notes) return;
  await db
    .insert(researchNotes)
    .values({ ...ids, kind, notes: found.notes, searches: found.searches });
}

/** The research made in a session so far, oldest first, for its later calls; "" when none. */
export async function sessionResearch(db: Db, sessionId: string): Promise<string> {
  const rows = await db
    .select({ kind: researchNotes.kind, notes: researchNotes.notes })
    .from(researchNotes)
    .where(eq(researchNotes.sessionId, sessionId))
    .orderBy(asc(researchNotes.createdAt), asc(researchNotes.id));
  return rows
    .map(
      (r) =>
        `### ${r.kind === "plan" ? "Scoping the field, for the plan" : "Checked for the lesson"}\n\n${r.notes}`,
    )
    .join("\n\n");
}

const searchLabel = (query: string | undefined) =>
  query ? `Searching the web for “${query}”` : "Searching the web";

/** A search's query, where the provider reports it: in the call's input or the result's action. */
function searchQuery(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if ("query" in value && typeof value.query === "string") return value.query;
  if ("action" in value) return searchQuery(value.action);
  return undefined;
}
