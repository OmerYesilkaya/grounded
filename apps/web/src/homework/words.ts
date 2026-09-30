import type { AnswerField, TaskForm } from "@grounded/core/assignment";
import type { Formats, Messages } from "@/i18n";
import { tagOf } from "@/lib/snooze";

/*
 * What the page calls a task's kind and its answer fields, in the app's language. Core's labels
 * (TASK_FORM_SPECS) are the English the tutor's prompts read; the page words them itself, by the
 * form and the field's key.
 */

type Words = Messages["homework"];

export const formLabel = (form: TaskForm, t: Words): string => t.forms[form];

/** A field's label and placeholder: its own, or a derivation's step n and its "because…". */
export function fieldWords(field: AnswerField, t: Words): { label: string; placeholder: string } {
  const step = /^(step|because)-(\d+)$/.exec(field.key);
  if (step) {
    const n = Number(step[2]);
    return step[1] === "step"
      ? { label: t.step(n), placeholder: n === 1 ? t.firstStepPlaceholder : t.nextStepPlaceholder }
      : { label: t.because, placeholder: t.becausePlaceholder };
  }
  const own = (t.fields as Record<string, { label: string; placeholder: string } | undefined>)[
    field.key
  ];
  return own ?? { label: field.label, placeholder: field.placeholder };
}

/** A field's label by its key, for a comment on it: "Your prediction", "Step 2". */
export const fieldLabelOf = (key: string, t: Words): string =>
  fieldWords({ key, label: key, placeholder: "" }, t).label;

/** When put-off homework is due, as a sentence's start: "Due tonight:". */
export function duePrefix(due: string, now: Date, t: Words, format: Formats): string {
  const tag = tagOf(due, now);
  return tag === "later"
    ? t.duePrefix.later(format.date(due, { day: "numeric", month: "short" }))
    : t.duePrefix[tag];
}

/** "29 Sep, 14:30": when it was assigned, handed in or locked. */
export const whenShort = (iso: string, format: Formats): string =>
  format.date(iso, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
