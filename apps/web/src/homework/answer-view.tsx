import { answerFields, type TaskAnswer, type TaskForm } from "@grounded/core/assignment";
import { parseAnswer } from "@grounded/content";
import type { ReactNode } from "react";
import { Blocks } from "@/content/blocks";
import { FieldLabel, LockedBadge } from "./task-fields";

/**
 * Where a field of a task's answer is on the page: its section's `data-step`, which the margin
 * comments find their passages in (lesson/passages.ts), its blocks' ids starting with it.
 */
export const fieldScope = (taskId: string, field: string) => `${taskId}-${field}`;

/**
 * A handed-in answer, read only (design §7.4): each field of the task's kind under its label, as the
 * lesson's text is shown, so a margin comment can mark the words it is about. `after` adds what
 * goes under a field (its comments, where there is no margin).
 */
export function AnswerView(props: {
  taskId: string;
  form: TaskForm;
  answer: TaskAnswer | undefined;
  after?: ((scope: string) => ReactNode) | undefined;
}) {
  const { taskId, form, answer } = props;
  const fields = answerFields(form, answer);
  const body = (key: string) => {
    const scope = fieldScope(taskId, key);
    return (
      <>
        <section
          data-step={scope}
          className="scroll-mt-24 font-serif text-[17px] leading-[1.7] text-foreground [&_p:last-child]:mb-0"
        >
          <Blocks blocks={parseAnswer(answer?.fields[key] ?? "", { idPrefix: `${scope}.b` })} />
        </section>
        {props.after?.(scope)}
      </>
    );
  };

  if (form === "derivation")
    return (
      <ol className="flex flex-col gap-7">
        {Array.from({ length: fields.length / 2 }, (_, i) => {
          const [step, because] = [fields[2 * i], fields[2 * i + 1]];
          if (!step || !because) return null;
          return (
            <li key={step.key} className="flex flex-col gap-2">
              <FieldLabel number={i + 1} label={step.label} />
              {body(step.key)}
              <div className="mt-1 ml-4 border-l-2 border-primary/40 pl-4">
                <div className="mb-1 font-serif text-[15px] text-muted-foreground italic">
                  Because…
                </div>
                {body(because.key)}
              </div>
            </li>
          );
        })}
      </ol>
    );

  return (
    <div className="flex flex-col gap-8">
      {fields.map((field, i) => (
        <div key={field.key} className="flex flex-col gap-2">
          <FieldLabel
            number={fields.length > 1 ? i + 1 : null}
            label={field.label}
            aside={
              field.key === "prediction" && answer?.lockedAt ? (
                <LockedBadge at={answer.lockedAt} />
              ) : null
            }
          />
          {body(field.key)}
        </div>
      ))}
    </div>
  );
}
