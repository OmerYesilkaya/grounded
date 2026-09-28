import type { LanguageModelV4 } from "@ai-sdk/provider";
import {
  parseLesson,
  splitLessonSteps,
  validateStep,
  type Issue,
  type LessonStep,
  type TrackTerm,
} from "@grounded/content";
import { generateText, Output, stepCountIs, streamText, type Instructions, type ToolSet } from "ai";
import { z } from "zod";
import type { LessonStepInfo, StepCheck } from "./session.js";

export const lessonOutlineSchema = z.object({
  steps: z
    .array(
      z.object({
        heading: z.string().min(1),
        /** What the step establishes, in a phrase. */
        establishes: z.string(),
        /** New terms this step names (each must be a planned term). */
        introduces: z.array(z.string()),
        /**
         * Terms this step builds on (held by the learner, or introduced by an earlier step). The app
         * places the lesson's checks from these (placeChecks).
         */
        restsOn: z.array(z.string()),
      }),
    )
    .min(1),
});

export type LessonOutline = z.infer<typeof lessonOutlineSchema>;

/**
 * A lesson's media (design §6.4): tools the outline may call to find images and recordings, and
 * the server's check of every step's media and links before the learner sees it.
 */
export interface LessonMedia {
  /** Offered to the outline only, so the lesson itself is never written around a tool call. */
  tools: ToolSet;
  /** What the tools found, as the writer is told it (a step's rewrite too); "" when nothing. */
  found: () => string;
  /**
   * Resolves a sound step's media and links. What can't be verified is left out of the step (or
   * kept as a link card) and reported with a degradable issue, so the step is rewritten first.
   */
  verify: (step: LessonStep) => Promise<{ step: LessonStep; issues: Issue[] }>;
}

/** Tool rounds the outline may take before it must answer. */
const OUTLINE_TOOL_STEPS = 8;

export interface GenerateLessonOptions {
  model: LanguageModelV4;
  /** The lesson phase's assembled prompt. */
  system: Instructions;
  /** What to teach: the approved plan and anything else the call needs. */
  request: string;
  terms: readonly TrackTerm[];
  glossary?: readonly string[];
  /** Called for each sound step, in order, as soon as it and every step before it are settled. */
  onStep: (step: LessonStep, markdown: string) => void | Promise<void>;
  onOutline?: (outline: LessonOutline) => void | Promise<void>;
  /**
   * Called as work on a step begins: its first writing (attempt 0) as the stream reaches it, and
   * each rewrite after it broke a rule (attempt 1, 2…), with the issues the rewrite fixes. Steps are
   * 0-indexed.
   */
  onStepStart?: (index: number, attempt: number, issues: readonly Issue[]) => void | Promise<void>;
  /** Called when an outline is asked for again (attempt 1, 2…), with how many problems it had. */
  onOutlineRejected?: (attempt: number, problems: number) => void | Promise<void>;
  /** Retries per outline and per broken step (default 2). */
  maxRetries?: number;
  /**
   * Writing the rest of a lesson whose writing stopped: its outline, and the markdown of the steps
   * already written, from the first (the rest are written after them). No outline is asked for.
   */
  resume?: { outline: LessonOutline; written: readonly string[] };
  /** Finding and verifying media; without it, steps are kept as parsed. */
  media?: LessonMedia;
}

export interface LessonResult {
  outline: LessonOutline;
  /** The steps this call wrote (after the ones it resumed from). */
  steps: LessonStep[];
  /** Every step of the outline, with the check it ends with, if any. */
  stepInfo: LessonStepInfo[];
  /** Steps still broken after the retries: the lesson fails there, and is written again from them. */
  failed: { stepId: string; heading: string; issues: Issue[] }[];
  /** Steps kept without their broken drawings or media. */
  degraded: { stepId: string; issues: Issue[] }[];
}

const USABLE = new Set(["confirmed", "assumed", "borrowed"]);
const DEGRADABLE = /^(diagram|stepper|chart|video|image|audio|link)\//;
const norm = (term: string) => term.trim().toLowerCase();

type Settled =
  | { kind: "ok"; step: LessonStep; markdown: string }
  | { kind: "degraded"; step: LessonStep; markdown: string; issues: Issue[] }
  | { kind: "failed"; issues: Issue[] }
  | { kind: "retry"; markdown: string; issues: Issue[] };

/**
 * The lesson pipeline (design §7.2): an outline checked against the term list, the whole lesson
 * written in one streamed call, each step validated as soon as it is complete. A broken step is
 * regenerated with its issues fed back; steps are released strictly in order. With `resume`, the
 * outline is the one given and the writing starts after the steps already written.
 */
export async function generateLesson(options: GenerateLessonOptions): Promise<LessonResult> {
  const retries = options.maxRetries ?? 2;
  const { resume } = options;
  const outline = resume?.outline ?? (await writeOutline(options, retries));
  if (!resume) await options.onOutline?.(outline);
  const planned: Planned = { outline, steps: placeChecks(outline) };
  // The first step this call writes: the stream's pieces start there.
  const first = resume?.written.length ?? 0;

  const settled: (Settled | undefined)[] = [];
  let released = first;
  const release = async () => {
    for (
      let entry = settled[released];
      entry && entry.kind !== "retry";
      entry = settled[released]
    ) {
      if (entry.kind !== "failed") await options.onStep(entry.step, entry.markdown);
      released += 1;
    }
  };

  const stream = streamText({
    model: options.model,
    system: options.system,
    prompt: resume
      ? resumePrompt(options.request, planned, resume.written)
      : writePrompt(options.request, planned, options.media?.found() ?? ""),
  });
  let buffer = "";
  let checked = 0;
  let started = 0;
  // The full stream, not textStream: textStream drops error parts, so a provider failure mid-lesson
  // would end the lesson quietly instead of failing it.
  for await (const part of stream.stream) {
    if (part.type === "error") throw part.error;
    if (part.type !== "text-delta") continue;
    buffer += part.text;
    const pieces = splitLessonSteps(buffer);
    for (; started < pieces.length; started++) await options.onStepStart?.(first + started, 0, []);
    for (; checked < pieces.length - 1; checked++) {
      settled[first + checked] = await check(
        pieces[checked] ?? "",
        first + checked,
        planned,
        options,
      );
      await release();
    }
  }
  const pieces = splitLessonSteps(buffer);
  for (; checked < pieces.length; checked++)
    settled[first + checked] = await check(
      pieces[checked] ?? "",
      first + checked,
      planned,
      options,
    );

  for (let index = first; index < settled.length; index++) {
    let entry = settled[index];
    for (let attempt = 0; entry?.kind === "retry" && attempt < retries; attempt++) {
      await options.onStepStart?.(index, attempt + 1, entry.issues);
      const markdown = await regenerate(options, planned, index, entry);
      entry = await check(markdown, index, planned, options);
    }
    if (entry?.kind === "retry") entry = await finalize(entry, index, planned, options);
    settled[index] = entry;
    await release();
  }

  const steps: LessonStep[] = [];
  const failed: LessonResult["failed"] = [];
  const degraded: LessonResult["degraded"] = [];
  settled.forEach((entry, index) => {
    const stepId = `s${String(index + 1)}`;
    if (!entry || entry.kind === "retry") return;
    if (entry.kind === "failed")
      failed.push({ stepId, heading: outline.steps[index]?.heading ?? "", issues: entry.issues });
    else steps.push(entry.step);
    if (entry.kind === "degraded") degraded.push({ stepId, issues: entry.issues });
  });
  return { outline, steps, stepInfo: planned.steps, failed, degraded };
}

async function writeOutline(
  options: GenerateLessonOptions,
  retries: number,
): Promise<LessonOutline> {
  let feedback = "";
  const tools = options.media?.tools;
  const finding = tools
    ? " Where a step would be clearer with a real image or recording (the thing itself, a historical document, how it sounds), look for one with find_image or find_audio now: the lesson is written with what you find."
    : "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { output } = await generateText({
      model: options.model,
      system: options.system,
      output: Output.object({ schema: lessonOutlineSchema }),
      prompt: `${options.request}\n\nWrite the lesson's outline first: its steps in order.${finding}${feedback}`,
      ...(tools
        ? {
            tools,
            stopWhen: stepCountIs(OUTLINE_TOOL_STEPS),
            // The last round has no tools, so the outline always ends in its answer.
            prepareStep: ({ stepNumber }: { stepNumber: number }) =>
              stepNumber === OUTLINE_TOOL_STEPS - 1 ? { activeTools: [] } : {},
          }
        : {}),
    });
    const errors = outlineErrors(output, options.terms);
    if (errors.length === 0) return output;
    if (attempt < retries) await options.onOutlineRejected?.(attempt + 1, errors.length);
    feedback = `\n\nYour previous outline had these problems; fix them:\n${errors.map((e) => `- ${e}`).join("\n")}`;
  }
  throw new Error("The lesson outline could not be made consistent with the term list.");
}

function outlineErrors(outline: LessonOutline, terms: readonly TrackTerm[]): string[] {
  const status = new Map(terms.map((t) => [norm(t.term), t.status]));
  const have = new Set(terms.filter((t) => USABLE.has(t.status)).map((t) => norm(t.term)));
  const errors: string[] = [];
  outline.steps.forEach((step, i) => {
    const n = String(i + 1);
    for (const term of step.introduces) {
      const s = status.get(norm(term));
      if (s !== "planned" && s !== "taught")
        errors.push(`Step ${n} introduces "${term}", which isn't a planned term.`);
    }
    for (const term of step.restsOn) {
      if (!have.has(norm(term)) && !step.introduces.some((t) => norm(t) === norm(term))) {
        errors.push(
          `Step ${n} rests on "${term}", which the learner doesn't have yet and no earlier step introduces.`,
        );
      }
    }
    for (const term of step.introduces) have.add(norm(term));
  });
  return errors;
}

/** The outline, with the checks the app placed on it. */
interface Planned {
  outline: LessonOutline;
  steps: LessonStepInfo[];
}

function introducedUpTo(outline: LessonOutline, index: number): string[] {
  return outline.steps.slice(0, index + 1).flatMap((s) => s.introduces);
}

/** Parses and validates a step, then verifies its media and links on the server. */
async function check(
  markdown: string,
  index: number,
  planned: Planned,
  options: GenerateLessonOptions,
): Promise<Settled> {
  const parsed = parseLesson(markdown, { firstStepNumber: index + 1 });
  const [step] = parsed.steps;
  const issues = [...parsed.issues];
  if (step) issues.push(...stepErrors(step, index, planned, options));
  if (!step && issues.length === 0)
    issues.push({ code: "lesson/empty", message: "The step is empty." });
  if (!step || issues.length > 0) return { kind: "retry", markdown, issues };
  if (!options.media) return { kind: "ok", step, markdown };
  const verified = await options.media.verify(step);
  return verified.issues.length === 0
    ? { kind: "ok", step: verified.step, markdown }
    : { kind: "retry", markdown, issues: verified.issues };
}

function stepErrors(
  step: LessonStep,
  index: number,
  planned: Planned,
  options: GenerateLessonOptions,
): Issue[] {
  return [
    ...checkPlacementErrors(step, planned.steps[index]?.check ?? null),
    ...validateStep(step, {
      terms: options.terms,
      introduced: introducedUpTo(planned.outline, index),
      ...(options.glossary ? { glossary: options.glossary } : {}),
    }),
  ].filter((issue) => issue.severity !== "review");
}

/** A step ends with a check exactly where the app placed one. */
function checkPlacementErrors(step: LessonStep, placed: StepCheck | null): Issue[] {
  if (placed && !step.check)
    return [
      {
        code: "lesson/missing-check",
        message: `This step must end with a :::check block: ${checkBrief(placed)}.`,
      },
    ];
  if (!placed && step.check)
    return [
      {
        code: "lesson/unexpected-check",
        message:
          "This step ends without a check: nothing ahead rests on it yet, and a later check covers it. Remove the :::check block.",
      },
    ];
  return [];
}

/**
 * After the last retry: keep the step without broken drawings or media (what can't be verified is
 * left out or kept as a link card), or report it failed.
 */
async function finalize(
  entry: Extract<Settled, { kind: "retry" }>,
  index: number,
  planned: Planned,
  options: GenerateLessonOptions,
): Promise<Settled> {
  if (entry.issues.every((i) => DEGRADABLE.test(i.code))) {
    const parsed = parseLesson(entry.markdown, {
      firstStepNumber: index + 1,
      tolerate: (i) => DEGRADABLE.test(i.code),
    });
    const [step] = parsed.steps;
    if (step && stepErrors(step, index, planned, options).length === 0) {
      const kept = options.media ? (await options.media.verify(step)).step : step;
      return { kind: "degraded", step: kept, markdown: entry.markdown, issues: entry.issues };
    }
  }
  return { kind: "failed", issues: entry.issues };
}

async function regenerate(
  options: GenerateLessonOptions,
  planned: Planned,
  index: number,
  entry: Extract<Settled, { kind: "retry" }>,
): Promise<string> {
  const { text } = await generateText({
    model: options.model,
    system: options.system,
    prompt: [
      `Rewrite step ${String(index + 1)} of the lesson, and only that step.`,
      planned.outline.steps[index] ? `Its outline: ${stepBrief(planned, index)}` : "",
      "Your previous version:",
      entry.markdown,
      "Fix these problems:",
      ...entry.issues.map((i) => `- ${i.message}`),
      options.media?.found() ?? "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  return text;
}

function writePrompt(request: string, planned: Planned, found: string): string {
  const steps = planned.outline.steps
    .map((_, i) => `${String(i + 1)}. ${stepBrief(planned, i)}`)
    .join("\n");
  const media = found ? `\n\n${found}` : "";
  return `${request}\n\nWrite the whole lesson now, following this outline step by step:\n${steps}${media}`;
}

function resumePrompt(request: string, planned: Planned, written: readonly string[]): string {
  const steps = planned.outline.steps
    .map((_, i) => `${String(i + 1)}. ${stepBrief(planned, i)}`)
    .join("\n");
  const next = String(written.length + 1);
  const done = written.length === 1 ? "step is" : `${String(written.length)} steps are`;
  return [
    `${request}\n\nThe lesson follows this outline:\n${steps}`,
    `Its first ${done} written already:\n\n${written.join("\n\n")}`,
    `Write the rest of the lesson now, from step ${next} to the end, following the outline step by step. Start with step ${next}'s heading.`,
  ].join("\n\n");
}

function stepBrief(planned: Planned, index: number): string {
  const step = planned.outline.steps[index];
  if (!step) return "";
  const placed = planned.steps[index]?.check ?? null;
  const ending = placed
    ? `it ends with a check: ${checkBrief(placed)}`
    : "it ends without a check (nothing ahead rests on it yet; a later check covers it)";
  return `"${step.heading}" establishes ${step.establishes}; introduces ${step.introduces.join(", ") || "nothing new"}; ${ending}`;
}

/** What a placed check asks about, for the lesson's writer. */
function checkBrief(placed: StepCheck): string {
  const where = placed.steps.map((id) => `step ${id.slice(1)}`).join(", ");
  const what = placed.terms.length
    ? `on ${placed.terms.map((t) => `"${t}"`).join(", ")} (taught in ${where})`
    : `on what ${where} establishes`;
  const why = placed.gates
    ? "the next step rests on it"
    : "the lesson's last check, before the homework, covering what no check has yet";
  const many =
    placed.steps.length > 1 ? "; one question that needs them together where it can" : "";
  return `${what}, because ${why}${many}`;
}

/**
 * Where the lesson's checks go (design §7.3): a check at the point of need. Before a step that
 * rests on terms this lesson taught and no check has covered, the step before it ends with a check
 * on those terms, however far back they were taught. The last step always ends with one, on
 * everything still unchecked, since the homework rests on the whole lesson. Every other step has
 * none and opens with the step before it.
 */
export function placeChecks(outline: LessonOutline): LessonStepInfo[] {
  const id = (index: number) => `s${String(index + 1)}`;
  const checks: (StepCheck | null)[] = outline.steps.map(() => null);
  // Terms taught so far that no check has covered: the term as written, and the step teaching it.
  const pending = new Map<string, { term: string; step: number }>();
  const close = (at: number, due: { term: string; step: number }[], gates: boolean) => {
    const steps = [...new Set(due.map((d) => d.step))].sort((a, b) => a - b);
    checks[at] = {
      steps: (steps.length ? steps : [at]).map(id),
      terms: due.map((d) => d.term),
      gates,
    };
    for (const d of due) pending.delete(norm(d.term));
  };
  outline.steps.forEach((step, i) => {
    const due = [...new Set(step.restsOn.map(norm))].flatMap((t) => pending.get(t) ?? []);
    // Nothing is pending before the first step, so a due check always has a step before it.
    if (due.length > 0) close(i - 1, due, true);
    for (const term of step.introduces) pending.set(norm(term), { term, step: i });
  });
  if (outline.steps.length > 0) close(outline.steps.length - 1, [...pending.values()], false);
  return outline.steps.map((_, i) => ({ id: id(i), check: checks[i] ?? null }));
}
