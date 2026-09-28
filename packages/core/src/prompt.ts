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

/** Everything the app knows that a call may need (method.md, "What the app gives you"). */
export interface PromptContext {
  /** language is null until the tutor has inferred it from the learner's messages. */
  track?: { title: string; language: string | null };
  terms?: readonly TermRow[];
  borrowed?: readonly { term: string; fromTrack: string }[];
  plan?: { arcs: readonly { title: string; terms: readonly string[] }[]; notes?: string };
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
  /** The phase's method sections: the same for every call of the phase. */
  method: string;
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
  const body = method.sections
    .filter((s) => s.phases.includes("all") || s.phases.includes(phase))
    .map((s) => s.text)
    .join("\n\n");
  const track = renderTrack(context);
  const call = [
    ...renderChanges(context),
    ...(context.extra ?? []).map((s) => `## ${s.heading}\n\n${s.body}`),
  ].join("\n\n");
  // The heading opens the app's context, in whichever part the context starts.
  const headed = (part: string) => `${CONTEXT_HEADING}\n\n${part}`;
  return {
    method: body,
    track: track ? headed(track) : "",
    call: call && !track ? headed(call) : call,
  };
}

/** The whole prompt as one text: its parts in order. */
export function joinSystemPrompt(prompt: SystemPrompt): string {
  return [prompt.method, prompt.track, prompt.call].filter(Boolean).join("\n\n");
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
  const { track, terms, borrowed, plan, fixList, teachingNotes } = context;
  if (track) {
    const language =
      track.language ??
      "not known yet. Teach in the language the learner writes in, and record it with set-language.";
    parts.push(`## Track\n\nSubject: ${track.title}\nTeaching language: ${language}`);
  }
  if (plan) {
    const arcs = plan.arcs.map(
      (arc, i) => `${String(i + 1)}. ${arc.title}: ${arc.terms.join(", ")}`,
    );
    parts.push(["## Plan", "", ...arcs, ...(plan.notes ? ["", plan.notes] : [])].join("\n"));
  }
  if (terms?.length) parts.push(["## Term list", "", ...termTable(terms)].join("\n"));
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

function termTable(terms: readonly TermRow[]): string[] {
  const rows = terms.map(
    (t) => `| ${t.term} | ${t.status} | ${t.restsOn.length ? t.restsOn.join(", ") : "—"} |`,
  );
  return ["| term | status | rests on |", "| --- | --- | --- |", ...rows];
}

const fixLine = (f: FixItem) => `- [${f.status}] ${f.text}`;

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
