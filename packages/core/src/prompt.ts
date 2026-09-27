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

/** Everything the app knows that a call may need (method.md, "What the app gives you"). */
export interface PromptContext {
  /** language is null until the tutor has inferred it from the learner's messages. */
  track?: { title: string; language: string | null };
  terms?: readonly { term: string; status: TermStatus; restsOn: readonly string[] }[];
  borrowed?: readonly { term: string; fromTrack: string }[];
  plan?: { arcs: readonly { title: string; terms: readonly string[] }[]; notes?: string };
  fixList?: readonly { text: string; status: "open" | "closed" }[];
  teachingNotes?: readonly string[];
  /** Anything phase-specific, already rendered (the lesson, asides, the step being checked). */
  extra?: readonly { heading: string; body: string }[];
}

export function assemblePrompt(method: Method, phase: Phase, context: PromptContext): string {
  const body = method.sections
    .filter((s) => s.phases.includes("all") || s.phases.includes(phase))
    .map((s) => s.text)
    .join("\n\n");
  const rendered = renderContext(context);
  return rendered ? `${body}\n\n# What the app gives you in this call\n\n${rendered}` : body;
}

function renderContext(context: PromptContext): string {
  const parts: string[] = [];
  const { track, terms, borrowed, plan, fixList, teachingNotes, extra } = context;
  if (track) {
    const language =
      track.language ??
      "not known yet. Teach in the language the learner writes in, and record it with set-language.";
    parts.push(`## Track\n\nSubject: ${track.title}\nTeaching language: ${language}`);
  }
  if (terms?.length) {
    const rows = terms.map(
      (t) => `| ${t.term} | ${t.status} | ${t.restsOn.length ? t.restsOn.join(", ") : "—"} |`,
    );
    parts.push(
      ["## Term list", "", "| term | status | rests on |", "| --- | --- | --- |", ...rows].join(
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
  if (plan) {
    const arcs = plan.arcs.map(
      (arc, i) => `${String(i + 1)}. ${arc.title}: ${arc.terms.join(", ")}`,
    );
    parts.push(["## Plan", "", ...arcs, ...(plan.notes ? ["", plan.notes] : [])].join("\n"));
  }
  if (fixList?.length) {
    parts.push(["## Fix-list", "", ...fixList.map((f) => `- [${f.status}] ${f.text}`)].join("\n"));
  }
  if (teachingNotes?.length) {
    parts.push(["## Teaching notes", "", ...teachingNotes.map((n) => `- ${n}`)].join("\n"));
  }
  for (const section of extra ?? []) parts.push(`## ${section.heading}\n\n${section.body}`);
  return parts.join("\n\n");
}
