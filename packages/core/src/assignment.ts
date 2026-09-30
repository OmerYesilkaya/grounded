import type { Block } from "@grounded/content";
import { z } from "zod";
import type { FieldRef, RefusalNotice } from "./notices.js";

/*
 * Homework and arc exams (design §7.4, method.md "Homework"): an assignment is one or more tasks,
 * each of a typed kind with its own answer fields, and a "what a good answer demonstrates" list. The
 * learner's answers are markdown, written in the answer editor.
 */

/** The kinds of task (method.md, "Homework"), each with its own answer fields. */
export const TASK_FORMS = ["predict", "derivation", "build", "explain"] as const;
export type TaskForm = (typeof TASK_FORMS)[number];

/** Homework: one task, the session's. An arc exam: several, over the whole arc (#42). */
export type AssignmentKind = "homework" | "exam";

/** One task of an assignment: what it asks, written by the tutor, and the kind of answer it takes. */
export interface AssignmentTask {
  /** "t1", "t2", …: the prefix of its blocks' ids, and where its answers are kept. */
  id: string;
  /** The task's heading, where the assignment has several; null for homework's one task. */
  title: string | null;
  form: TaskForm;
  /** What it asks, as validated blocks. */
  blocks: Block[];
  /** The same as the tutor wrote it, for the prompts that read it. */
  source: string;
}

/** An item of "what a good answer demonstrates"; the review marks each one. */
export interface ChecklistItem {
  /** "c1", "c2", … */
  id: string;
  text: string;
}

/** The learner's answer to one task: each field's markdown, and when a prediction was locked. */
export interface TaskAnswer {
  fields: Record<string, string>;
  /** Predict → verify: when the prediction was locked (ISO time); null until it is. */
  lockedAt: string | null;
}

/** The learner's answers, by task id. */
export type Answers = Record<string, TaskAnswer | undefined>;

export interface AnswerField {
  key: string;
  label: string;
  /** What goes in it, as the empty box says. */
  placeholder: string;
}

interface FormSpec {
  /** What the kind is called, for the learner. */
  label: string;
  fields: AnswerField[];
}

/** Each kind's answer fields, in the order they are written. */
export const TASK_FORM_SPECS: Record<TaskForm, FormSpec> = {
  predict: {
    label: "Predict, then verify",
    fields: [
      {
        key: "prediction",
        label: "Your prediction",
        placeholder: "Before you check anything: what will happen, and why?",
      },
      {
        key: "observed",
        label: "What actually happened",
        placeholder: "Now check it. What did you see?",
      },
      {
        key: "reconcile",
        label: "Reconcile",
        placeholder: "Where your prediction and what happened differ, and why.",
      },
    ],
  },
  derivation: {
    label: "Derivation",
    // The steps, each with its "because…": as many as the learner writes (derivationFields).
    fields: [],
  },
  build: {
    label: "Build",
    fields: [
      {
        key: "work",
        label: "What you made",
        placeholder: "Your text, code or photos: paste a picture of a page if it's on paper.",
      },
      {
        key: "surprised",
        label: "What surprised you",
        placeholder: "Anything that didn't go the way you expected.",
      },
    ],
  },
  explain: {
    label: "Explain it to a friend",
    fields: [
      {
        key: "text",
        label: "Your explanation",
        placeholder: "In your own words, for a smart friend who wasn't there.",
      },
    ],
  },
};

/** The fields a prediction's lock holds back: they are written once the prediction is locked. */
export const AFTER_THE_LOCK: readonly string[] = ["observed", "reconcile"];

export const ANSWER_LIMITS = {
  /** Characters of markdown in one field. */
  field: 20_000,
  /** Steps of a derivation. */
  steps: 30,
  /** Pictures in one assignment's answers, each at most an image attachment's size (§4.5). */
  pictures: 20,
};

const stepKey = (n: number) => `step-${String(n)}`;
const becauseKey = (n: number) => `because-${String(n)}`;

/** How many steps a derivation's answer has: the highest step written, and at least one. */
export function stepCount(answer: TaskAnswer | undefined): number {
  let count = 1;
  for (const key of Object.keys(answer?.fields ?? {})) {
    const n = Number(/^(?:step|because)-(\d+)$/.exec(key)?.[1] ?? 0);
    if (n > count) count = n;
  }
  return Math.min(count, ANSWER_LIMITS.steps);
}

/** A derivation's fields: each step, then its "because…". */
export function derivationFields(steps: number): AnswerField[] {
  const fields: AnswerField[] = [];
  for (let n = 1; n <= steps; n++) {
    fields.push({
      key: stepKey(n),
      label: `Step ${String(n)}`,
      placeholder: n === 1 ? "Start from what you know is true." : "What follows next.",
    });
    fields.push({ key: becauseKey(n), label: "Because…", placeholder: "Why it has to be so." });
  }
  return fields;
}

/** A task's answer fields, in order: a derivation's as many steps as the answer has. */
export function answerFields(form: TaskForm, answer?: TaskAnswer): AnswerField[] {
  return form === "derivation" ? derivationFields(stepCount(answer)) : TASK_FORM_SPECS[form].fields;
}

/** Whether a key names one of the form's fields (any step of a derivation). */
function fieldAllowed(form: TaskForm, key: string): boolean {
  if (form !== "derivation") return TASK_FORM_SPECS[form].fields.some((f) => f.key === key);
  const n = Number(/^(?:step|because)-(\d+)$/.exec(key)?.[1] ?? 0);
  return n >= 1 && n <= ANSWER_LIMITS.steps;
}

/** A field's key as a notice names it: "step-2" is the second step. */
function fieldRef(key: string): FieldRef {
  const step = /^(step|because)-(\d+)$/.exec(key);
  if (step) return { field: step[1] as "step" | "because", step: Number(step[2]) };
  return { field: key as Exclude<FieldRef, { step: number }>["field"] };
}

/**
 * What is wrong with a task's answer, for the learner (a notice the web words), or null. `complete`: it is being
 * handed in, so every field must be written (an assignment is never handed in half-done; method.md,
 * "The arc exam"), and a prediction must have been locked first.
 */
export function answerProblem(
  task: Pick<AssignmentTask, "form" | "title">,
  answer: TaskAnswer | undefined,
  options: { complete: boolean },
): RefusalNotice | null {
  const fields = answer?.fields ?? {};
  for (const [key, value] of Object.entries(fields)) {
    if (!fieldAllowed(task.form, key)) return { code: "no-such-field", key };
    if (value.length > ANSWER_LIMITS.field)
      return { code: "answer-too-long", max: ANSWER_LIMITS.field };
  }
  if (!options.complete) return null;
  const part = task.title === "" ? null : task.title;
  if (task.form === "predict" && !answer?.lockedAt) return { code: "lock-prediction-first", part };
  const missing = answerFields(task.form, answer).find((f) => !fields[f.key]?.trim());
  return missing ? { code: "answer-missing", part, ...fieldRef(missing.key) } : null;
}

/**
 * The learner's answers as the tutor reads them (the review's prompt): each task's fields under
 * their labels, the prediction with when it was locked. Pictures stay in the markdown as written
 * (`![…](…)`); the prompt sends them along as images.
 */
export function answersMarkdown(
  tasks: readonly Pick<AssignmentTask, "id" | "title" | "form">[],
  answers: Answers,
): string {
  return tasks
    .map((task, i) => {
      const answer = answers[task.id];
      const heading =
        tasks.length > 1
          ? `## Task ${String(i + 1)} (${task.id})${task.title ? `: ${task.title}` : ""}`
          : `## The answer (${task.id})`;
      const fields = answerFields(task.form, answer).map((field) => {
        const locked =
          field.key === "prediction" && answer?.lockedAt
            ? ` (locked at ${answer.lockedAt}, before verifying)`
            : "";
        const text = answer?.fields[field.key]?.trim() ?? "";
        return `### ${field.label} [field: ${field.key}]${locked}\n\n${text === "" ? "(left empty)" : text}`;
      });
      return [heading, ...fields].join("\n\n");
    })
    .join("\n\n");
}

/**
 * The structured record after an assignment's message (design §7.1, prose first): what the kind
 * of each task is, a name for it, and what a good answer demonstrates.
 */
export const assignmentRecordSchema = z.object({
  title: z
    .string()
    .min(1)
    .describe(
      'A few words naming what the assignment is about, for the learner\'s list ("Two workers, one counter").',
    ),
  forms: z
    .array(z.enum(TASK_FORMS))
    .describe(
      "The kind of each task, in order: predict (predict → verify), derivation, build, explain (explain it to a friend). One for homework; one per part for an exam.",
    ),
  checklist: z
    .array(z.string().min(1))
    .describe(
      "What a good answer demonstrates: two to six short items, each one thing the learner can check their answer against before handing it in. Obeys the term list like everything the learner reads.",
    ),
});

export type AssignmentRecord = z.infer<typeof assignmentRecordSchema>;
