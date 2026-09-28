/** The phases of method.md's tags (see its header comment). */
export const PHASES = [
  "probe",
  "plan",
  "lesson",
  "check",
  "homework",
  "review",
  "close",
  "aside",
  "final",
  "profile",
] as const;

export type Phase = (typeof PHASES)[number];

interface Section {
  phases: readonly (Phase | "all")[];
  text: string;
}

export interface Method {
  sections: readonly Section[];
}

const TAG = /^<!-- phases: ([a-z ]+) -->$/gm;

/** Splits method.md at its phase tags. Text before the first tag (the header comment) is dropped. */
export function parseMethod(markdown: string): Method {
  const tags = [...markdown.matchAll(TAG)];
  const sections = tags.map((tag, i): Section => {
    const phases = (tag[1] ?? "").trim().split(/\s+/);
    for (const phase of phases) {
      if (phase !== "all" && !(PHASES as readonly string[]).includes(phase)) {
        throw new Error(`Unknown phase "${phase}" in method.md.`);
      }
    }
    const start = tag.index + tag[0].length;
    const end = tags[i + 1]?.index ?? markdown.length;
    return { phases: phases as Section["phases"], text: markdown.slice(start, end).trim() };
  });
  return { sections };
}

export type TermStatus = "planned" | "taught" | "confirmed" | "assumed";

export interface TermRow {
  term: string;
  status: TermStatus;
  restsOn: readonly string[];
}

export interface FixItem {
  text: string;
  status: "open" | "closed";
}

export interface PlanArc {
  title: string;
  terms: readonly string[];
  /** The arc the track has reached (design §4.4). */
  current?: boolean;
  /** Shown in place of the arc's terms: how many it has at each status. */
  tally?: Partial<Record<TermStatus, number>>;
}

/** Everything the app knows that a call may need (method.md, "What the app gives you"). */
export interface PromptContext {
  /** language is null until the tutor has inferred it from the learner's messages. */
  track?: { title: string; language: string | null };
  /**
   * The files the learner attached to the track, and "what you brought", their summary (null
   * until written). Left out where a call reads the files themselves (design §4.5).
   */
  brought?: { files: readonly string[]; summary: string | null };
  terms?: readonly TermRow[];
  /** The track's terms the term list leaves out (design §4.4), counted by status. */
  termsNotListed?: Partial<Record<TermStatus, number>>;
  borrowed?: readonly { term: string; fromTrack: string }[];
  /**
   * notes: the plan's notes as written. leftOff: "where you left off", the close's compact summary
   * of them, which a call carries in their place (design §4.4).
   */
  plan?: { arcs: readonly PlanArc[]; notes?: string; leftOff?: string };
  fixList?: readonly FixItem[];
  teachingNotes?: readonly string[];
  /**
   * In a session, the term list and fix-list above are as the session began, so the track's part
   * stays the same all session (design §4.4); what changed since comes here, in the call's part.
   */
  changes?: { terms: readonly TermRow[]; fixList: readonly FixItem[] };
  /** Anything phase-specific, already rendered (the lesson, asides, the step being checked). */
  extra?: readonly { heading: string; body: string }[];
}

/**
 * A call's system prompt in parts, ordered so that its start stays byte-identical from one call of a
 * track to the next (design §4.4): providers reuse a cached prefix, so what changes least comes
 * first. Joined, the parts are the prompt the model reads.
 */
export interface SystemPrompt {
  /**
   * The method's leading `all` sections: the same for every call of every phase, so calls of
   * different phases share it from the cache.
   */
  sharedMethod: string;
  /** The phase's own method sections, after the shared ones: the same for every call of the phase. */
  phaseMethod: string;
  /** The track's slowly changing state, under the context heading; "" when the call has none. */
  track: string;
  /** What only this call carries (the step being checked, research notes…); "" when none. */
  call: string;
}

const CONTEXT_HEADING = "# What the app gives you in this call";

export function assembleSystemPrompt(
  method: Method,
  phase: Phase,
  context: PromptContext,
): SystemPrompt {
  // The shared part runs up to the first section not tagged `all`; method.md keeps every `all`
  // section in that run, and one placed later would count as the phase's.
  const first = method.sections.findIndex((s) => !s.phases.includes("all"));
  const leading = first === -1 ? method.sections.length : first;
  const text = (sections: readonly Section[]) => sections.map((s) => s.text).join("\n\n");
  const phaseSections = method.sections
    .slice(leading)
    .filter((s) => s.phases.includes("all") || s.phases.includes(phase));
  const track = renderTrack(context);
  const call = [
    ...renderChanges(context),
    ...(context.extra ?? []).map((s) => `## ${s.heading}\n\n${s.body}`),
  ].join("\n\n");
  // The heading opens the app's context, in whichever part the context starts.
  const headed = (part: string) => `${CONTEXT_HEADING}\n\n${part}`;
  return {
    sharedMethod: text(method.sections.slice(0, leading)),
    phaseMethod: text(phaseSections),
    track: track ? headed(track) : "",
    call: call && !track ? headed(call) : call,
  };
}

/** The whole prompt as one text: its parts in order. */
export function joinSystemPrompt(prompt: SystemPrompt): string {
  return [prompt.sharedMethod, prompt.phaseMethod, prompt.track, prompt.call]
    .filter(Boolean)
    .join("\n\n");
}

export function assemblePrompt(method: Method, phase: Phase, context: PromptContext): string {
  return joinSystemPrompt(assembleSystemPrompt(method, phase, context));
}

/**
 * The track's state, slowest-changing first: the subject and language are set once, the plan changes
 * when it is revised, and term statuses and the fix-list change within a session.
 */
function renderTrack(context: PromptContext): string {
  const parts: string[] = [];
  const { track, brought, terms, termsNotListed, borrowed, plan, fixList, teachingNotes } = context;
  if (track) {
    const language =
      track.language ??
      "not known yet. Teach in the language the learner writes in, and record it with set-language.";
    parts.push(`## Track\n\nSubject: ${track.title}\nTeaching language: ${language}`);
  }
  if (brought) {
    const files = `Files they attached when they started the track: ${brought.files.join(", ")}.`;
    const summary =
      brought.summary ?? "(Not summarized: what is in them isn't known in this call.)";
    parts.push(["## What the learner brought", "", files, "", summary].join("\n"));
  }
  if (plan) {
    const arcs = plan.arcs.map((arc, i) => `${String(i + 1)}. ${arcLine(arc)}`);
    const notes = plan.notes ? ["", plan.notes] : [];
    const leftOff = plan.leftOff ? ["", "### Where you left off", "", plan.leftOff] : [];
    parts.push(["## Plan", "", ...arcs, ...notes, ...leftOff].join("\n"));
  }
  const unlisted = counted(termsNotListed ?? {});
  if (terms?.length || unlisted.total > 0) {
    const table = terms?.length ? termTable(terms) : [];
    const rest = unlisted.total
      ? [
          `Not listed here: ${String(unlisted.total)} more terms of this track (${unlisted.text}), away from the current arc and from what recent sessions touched. Don't use them as known terms.`,
        ]
      : [];
    parts.push(
      ["## Term list", "", ...table, ...(table.length && rest.length ? [""] : []), ...rest].join(
        "\n",
      ),
    );
  }
  if (borrowed?.length) {
    parts.push(
      [
        "## Borrowed terms",
        "",
        ...borrowed.map((b) => `- ${b.term} (confirmed in ${b.fromTrack})`),
      ].join("\n"),
    );
  }
  if (fixList?.length) parts.push(["## Fix-list", "", ...fixList.map(fixLine)].join("\n"));
  if (teachingNotes?.length) {
    parts.push(["## Teaching notes", "", ...teachingNotes.map((n) => `- ${n}`)].join("\n"));
  }
  return parts.join("\n\n");
}

/**
 * Several terms in a line. A term's name may hold commas and semicolons of its own (a track
 * imported from long notes has names like "index; B-tree (…); measured 4 levels at 10M"), so the
 * names are set apart by a mark no name uses, and a model copying one copies all of it.
 */
const termNames = (names: readonly string[]) => names.join(" · ");

function termTable(terms: readonly TermRow[]): string[] {
  const cell = (text: string) => text.replaceAll("|", "\\|");
  const rows = terms.map(
    (t) =>
      `| ${cell(t.term)} | ${t.status} | ${t.restsOn.length ? cell(termNames(t.restsOn)) : "—"} |`,
  );
  return ["| term | status | rests on |", "| --- | --- | --- |", ...rows];
}

const fixLine = (f: FixItem) => `- [${f.status}] ${f.text}`;

const STATUS_ORDER: readonly TermStatus[] = ["planned", "taught", "confirmed", "assumed"];

/** "3 planned, 12 confirmed", in the statuses' order, with the total. */
function counted(counts: Partial<Record<TermStatus, number>>) {
  const present = STATUS_ORDER.filter((s) => (counts[s] ?? 0) > 0);
  return {
    total: present.reduce((sum, s) => sum + (counts[s] ?? 0), 0),
    text: present.map((s) => `${String(counts[s] ?? 0)} ${s}`).join(", "),
  };
}

function arcLine(arc: PlanArc): string {
  const title = arc.current ? `${arc.title} (the current arc)` : arc.title;
  if (!arc.tally) return `${title}: ${termNames(arc.terms)}`;
  const { text } = counted(arc.tally);
  return `${title}: ${String(arc.terms.length)} terms${text ? ` (${text})` : ""}`;
}

/** The session's changes to the term list and fix-list: newer than the track's part. */
function renderChanges({ changes }: PromptContext): string[] {
  if (!changes || (changes.terms.length === 0 && changes.fixList.length === 0)) return [];
  const lines = [
    "## Changed since this session began",
    "",
    "Newer than the term list and fix-list above: where they differ, these hold.",
  ];
  if (changes.terms.length) lines.push("", ...termTable(changes.terms));
  if (changes.fixList.length) lines.push("", ...changes.fixList.map(fixLine));
  return [lines.join("\n")];
}
