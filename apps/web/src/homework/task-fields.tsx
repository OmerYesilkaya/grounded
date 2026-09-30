import {
  AFTER_THE_LOCK,
  ANSWER_LIMITS,
  answerFields,
  stepCount,
  type AnswerField,
  type TaskAnswer,
  type TaskForm,
} from "@grounded/core/assignment";
import { Lock, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AnswerEditor } from "@/editor/answer-editor";
import type { UploadPicture } from "@/editor/pictures";
import { useFormat, useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { fieldWords, whenShort } from "./words";

export interface TaskFieldsProps {
  form: TaskForm;
  answer: TaskAnswer | undefined;
  /** Handed in: shown, not changed. */
  readOnly: boolean;
  onChange: (key: string, value: string) => void;
  onLock: () => Promise<void>;
  upload: UploadPicture;
  onError: (message: string) => void;
}

/**
 * A task's answer boxes, the kind's own (design §7.4): predict → verify's prediction, locked
 * before what happened and the reconciling open; a derivation's steps, each with its "because…";
 * a build's work and what surprised; one box to explain it to a friend.
 */
export function TaskFields(props: TaskFieldsProps) {
  const { form, answer, readOnly } = props;
  const t = useT().homework;
  // A derivation grows by the steps the learner adds, written or not yet.
  const [added, setAdded] = useState(0);
  const locked = answer?.lockedAt ?? null;
  const steps = Math.min(stepCount(answer) + added, ANSWER_LIMITS.steps);
  const fields = form === "derivation" ? answerFields(form, stepAnswer(steps)) : answerFields(form);

  const editor = (field: AnswerField, options: { readOnly?: boolean; compact?: boolean } = {}) => (
    <AnswerEditor
      key={field.key}
      initial={answer?.fields[field.key] ?? ""}
      onChange={(value) => {
        props.onChange(field.key, value);
      }}
      label={fieldWords(field, t).label}
      placeholder={fieldWords(field, t).placeholder}
      readOnly={readOnly || options.readOnly === true}
      upload={props.upload}
      onError={props.onError}
      className={cn(options.compact && "[&_.answer-prose]:min-h-12")}
    />
  );

  if (form === "derivation") {
    return (
      <ol className="flex flex-col gap-6">
        {Array.from({ length: steps }, (_, i) => {
          const [step, because] = [fields[2 * i], fields[2 * i + 1]];
          if (!step || !because) return null;
          return (
            <li key={step.key} className="flex flex-col gap-2">
              <FieldLabel number={i + 1} label={fieldWords(step, t).label} />
              {editor(step, { compact: true })}
              <div className="ml-4 border-l-2 border-primary/40 pl-4">
                <div className="mb-1.5 font-serif text-[15px] text-muted-foreground italic">
                  {t.because}
                </div>
                {editor(because, { compact: true })}
              </div>
            </li>
          );
        })}
        {!readOnly && steps < ANSWER_LIMITS.steps && (
          <li>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setAdded(added + 1);
              }}
              className="border-dashed text-muted-foreground"
            >
              <Plus aria-hidden /> {t.addStep}
            </Button>
          </li>
        )}
      </ol>
    );
  }

  return (
    <div className="flex flex-col gap-7">
      {fields.map((field, i) => {
        const waitsForLock = form === "predict" && !locked && AFTER_THE_LOCK.includes(field.key);
        const isPrediction = form === "predict" && field.key === "prediction";
        return (
          <div key={field.key} className="flex flex-col gap-2">
            <FieldLabel
              number={fields.length > 1 ? i + 1 : null}
              label={fieldWords(field, t).label}
              aside={isPrediction && locked ? <LockedBadge at={locked} /> : null}
            />
            {waitsForLock ? (
              <p className="rounded-lg border border-dashed px-3.5 py-3 text-[13.5px] text-subtle-foreground">
                {t.opensOnceLocked}
              </p>
            ) : (
              editor(field, { readOnly: isPrediction && locked !== null })
            )}
            {isPrediction && !locked && !readOnly && (
              <LockPrediction onLock={props.onLock} empty={!answer?.fields.prediction?.trim()} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** An answer shaped like one with this many steps, for their fields. */
const stepAnswer = (steps: number): TaskAnswer => ({
  fields: { [`step-${String(steps)}`]: "" },
  lockedAt: null,
});

export function FieldLabel(props: { number: number | null; label: string; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2.5">
      {props.number !== null && (
        <span className="font-serif text-[15px] text-primary tabular-nums">{props.number}</span>
      )}
      <h3 className="text-[13px] font-semibold tracking-wide text-foreground">{props.label}</h3>
      {props.aside}
    </div>
  );
}

export function LockedBadge({ at }: { at: string }) {
  const t = useT().homework;
  const format = useFormat();
  return (
    <span className="ml-auto flex items-center gap-1 text-[12px] text-muted-foreground">
      <Lock className="size-3" aria-hidden />
      {t.locked(whenShort(at, format))}
    </span>
  );
}

function LockPrediction(props: { onLock: () => Promise<void>; empty: boolean }) {
  const [locking, setLocking] = useState(false);
  const t = useT().homework;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={props.empty || locking}
        onClick={() => {
          setLocking(true);
          void props.onLock().finally(() => {
            setLocking(false);
          });
        }}
      >
        <Lock aria-hidden /> {t.lockPrediction}
      </Button>
      <span className="text-[12.5px] text-subtle-foreground">{t.lockNote}</span>
    </div>
  );
}
