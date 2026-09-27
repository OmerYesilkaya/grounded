import type { LanguageModelV4 } from "@ai-sdk/provider";
import {
  parseLesson,
  splitLessonSteps,
  validateStep,
  type Issue,
  type LessonStep,
  type TrackTerm,
} from "@grounded/content";
import { generateText, Output, streamText } from "ai";
import { z } from "zod";
import type { LessonStepInfo } from "./session.js";

export const lessonOutlineSchema = z.object({
  steps: z
    .array(
      z.object({
        heading: z.string().min(1),
        /** What the step establishes, in a phrase. */
        establishes: z.string(),
        /** New terms this step names (each must be a planned term). */
        introduces: z.array(z.string()),
        /** Terms this step builds on (held by the learner, or introduced by an earlier step). */
        restsOn: z.array(z.string()),
        check: z.string().min(1),
      }),
    )
    .min(1),
});

export type LessonOutline = z.infer<typeof lessonOutlineSchema>;

export interface GenerateLessonOptions {
  model: LanguageModelV4;
  /** The lesson phase's assembled prompt. */
  system: string;
  /** What to teach: the approved plan and anything else the call needs. */
  request: string;
  terms: readonly TrackTerm[];
  glossary?: readonly string[];
  /** Called for each sound step, in order, as soon as it and every step before it are settled. */
  onStep: (step: LessonStep) => void | Promise<void>;
  onOutline?: (outline: LessonOutline) => void | Promise<void>;
  /** Retries per outline and per broken step (default 2). */
  maxRetries?: number;
}

export interface LessonResult {
  outline: LessonOutline;
  steps: LessonStep[];
  /** Every step of the outline, with whether it builds on the one before (the gate uses this). */
  stepInfo: LessonStepInfo[];
  /** Steps still broken after the retries; shown to the learner as failed, with "regenerate". */
  failed: { stepId: string; heading: string; issues: Issue[] }[];
  /** Steps kept without their broken drawings or media. */
  degraded: { stepId: string; issues: Issue[] }[];
}

const USABLE = new Set(["confirmed", "assumed", "borrowed"]);
const DEGRADABLE = /^(diagram|stepper|chart|video|image|audio|link)\//;
const norm = (term: string) => term.trim().toLowerCase();

type Settled =
  | { kind: "ok"; step: LessonStep }
  | { kind: "degraded"; step: LessonStep; issues: Issue[] }
  | { kind: "failed"; issues: Issue[] }
  | { kind: "retry"; markdown: string; issues: Issue[] };

/**
 * The lesson pipeline (design §7.2): an outline checked against the term list, the whole lesson
 * written in one streamed call, each step validated as soon as it is complete. A broken step is
 * regenerated with its issues fed back; steps are released strictly in order.
 */
export async function generateLesson(options: GenerateLessonOptions): Promise<LessonResult> {
  const retries = options.maxRetries ?? 2;
  const outline = await writeOutline(options, retries);
  await options.onOutline?.(outline);

  const settled: (Settled | undefined)[] = [];
  let released = 0;
  const release = async () => {
    for (
      let entry = settled[released];
      entry && entry.kind !== "retry";
      entry = settled[released]
    ) {
      if (entry.kind !== "failed") await options.onStep(entry.step);
      released += 1;
    }
  };

  const stream = streamText({
    model: options.model,
    system: options.system,
    prompt: writePrompt(options.request, outline),
  });
  let buffer = "";
  let checked = 0;
  for await (const delta of stream.textStream) {
    buffer += delta;
    const pieces = splitLessonSteps(buffer);
    for (; checked < pieces.length - 1; checked++) {
      settled[checked] = check(pieces[checked] ?? "", checked, outline, options);
      await release();
    }
  }
  const pieces = splitLessonSteps(buffer);
  for (; checked < pieces.length; checked++)
    settled[checked] = check(pieces[checked] ?? "", checked, outline, options);

  for (let index = 0; index < settled.length; index++) {
    let entry = settled[index];
    for (let attempt = 0; entry?.kind === "retry" && attempt < retries; attempt++) {
      const markdown = await regenerate(options, outline, index, entry);
      entry = check(markdown, index, outline, options);
    }
    if (entry?.kind === "retry") entry = finalize(entry, index, outline, options);
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
  return { outline, steps, stepInfo: stepInfoFor(outline), failed, degraded };
}

async function writeOutline(
  options: GenerateLessonOptions,
  retries: number,
): Promise<LessonOutline> {
  let feedback = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { output } = await generateText({
      model: options.model,
      system: options.system,
      output: Output.object({ schema: lessonOutlineSchema }),
      prompt: `${options.request}\n\nWrite the lesson's outline first: its steps in order.${feedback}`,
    });
    const errors = outlineErrors(output, options.terms);
    if (errors.length === 0) return output;
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

function introducedUpTo(outline: LessonOutline, index: number): string[] {
  return outline.steps.slice(0, index + 1).flatMap((s) => s.introduces);
}

function check(
  markdown: string,
  index: number,
  outline: LessonOutline,
  options: GenerateLessonOptions,
): Settled {
  const parsed = parseLesson(markdown, { firstStepNumber: index + 1 });
  const [step] = parsed.steps;
  const issues = [...parsed.issues];
  if (step) issues.push(...stepErrors(step, index, outline, options));
  if (!step && issues.length === 0)
    issues.push({ code: "lesson/empty", message: "The step is empty." });
  return step && issues.length === 0 ? { kind: "ok", step } : { kind: "retry", markdown, issues };
}

function stepErrors(
  step: LessonStep,
  index: number,
  outline: LessonOutline,
  options: GenerateLessonOptions,
): Issue[] {
  return validateStep(step, {
    terms: options.terms,
    introduced: introducedUpTo(outline, index),
    ...(options.glossary ? { glossary: options.glossary } : {}),
  }).filter((issue) => issue.severity !== "review");
}

/** After the last retry: keep the step without broken drawings or media, or report it failed. */
function finalize(
  entry: Extract<Settled, { kind: "retry" }>,
  index: number,
  outline: LessonOutline,
  options: GenerateLessonOptions,
): Settled {
  if (entry.issues.every((i) => DEGRADABLE.test(i.code))) {
    const parsed = parseLesson(entry.markdown, {
      firstStepNumber: index + 1,
      tolerate: (i) => DEGRADABLE.test(i.code),
    });
    const [step] = parsed.steps;
    if (step && stepErrors(step, index, outline, options).length === 0)
      return { kind: "degraded", step, issues: entry.issues };
  }
  return { kind: "failed", issues: entry.issues };
}

async function regenerate(
  options: GenerateLessonOptions,
  outline: LessonOutline,
  index: number,
  entry: Extract<Settled, { kind: "retry" }>,
): Promise<string> {
  const plan = outline.steps[index];
  const { text } = await generateText({
    model: options.model,
    system: options.system,
    prompt: [
      `Rewrite step ${String(index + 1)} of the lesson, and only that step.`,
      plan
        ? `Its outline: "${plan.heading}" establishes ${plan.establishes}; introduces ${plan.introduces.join(", ") || "no new terms"}; its check: ${plan.check}`
        : "",
      "Your previous version:",
      entry.markdown,
      "Fix these problems:",
      ...entry.issues.map((i) => `- ${i.message}`),
    ].join("\n\n"),
  });
  return text;
}

function writePrompt(request: string, outline: LessonOutline): string {
  const steps = outline.steps
    .map(
      (s, i) =>
        `${String(i + 1)}. ${s.heading}: establishes ${s.establishes}; introduces ${s.introduces.join(", ") || "nothing new"}; check: ${s.check}`,
    )
    .join("\n");
  return `${request}\n\nWrite the whole lesson now, following this outline step by step:\n${steps}`;
}

function stepInfoFor(outline: LessonOutline): LessonStepInfo[] {
  return outline.steps.map((step, i) => {
    const previous = outline.steps[i - 1];
    const restsOnPrevious =
      previous !== undefined &&
      step.restsOn.some((t) => previous.introduces.some((p) => norm(p) === norm(t)));
    return { id: `s${String(i + 1)}`, restsOnPrevious };
  });
}
