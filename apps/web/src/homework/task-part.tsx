import type { TaskAnswer } from "@grounded/core/assignment";
import type { ReactNode } from "react";
import { Blocks } from "@/content/blocks";
import type { UploadPicture } from "@/editor/pictures";
import { useT } from "@/i18n";
import type { Assignment } from "@/lib/assignments";
import { AnswerView } from "./answer-view";
import { TaskFields } from "./task-fields";
import { formLabel } from "./words";

type Task = Assignment["tasks"][number];

/**
 * One task's answer (design §7.4): its boxes while it is open, read only once it is handed in, as
 * the lesson's text is shown, so the review's comments can mark its words. `after` adds what goes
 * under a field of a handed-in answer (its comments, where there is no margin).
 */
export function TaskAnswerArea(props: {
  task: Task;
  answer: TaskAnswer | undefined;
  handedIn: boolean;
  readOnly: boolean;
  onChange: (key: string, value: string) => void;
  onLock: () => Promise<void>;
  upload: UploadPicture;
  onError: (message: string) => void;
  after?: ((scope: string) => ReactNode) | undefined;
}) {
  const { task, answer } = props;
  const t = useT().homework;
  // Under a part's own heading in an exam; the page's in homework.
  const Heading = task.title === null ? "h2" : "h3";
  if (props.handedIn)
    return (
      <>
        <Heading className="mb-5 text-[11px] font-semibold tracking-[0.12em] text-subtle-foreground uppercase">
          {t.yourAnswer}
        </Heading>
        <AnswerView taskId={task.id} form={task.form} answer={answer} after={props.after} />
      </>
    );
  return (
    <TaskFields
      form={task.form}
      answer={answer}
      readOnly={props.readOnly}
      onChange={props.onChange}
      onLock={props.onLock}
      upload={props.upload}
      onError={props.onError}
    />
  );
}

/**
 * A part of an arc exam (method.md, "The arc exam"): its number and kind, its name, what it asks,
 * and then its answer. Each part is a task of its own kind, answered in its own boxes.
 */
export function ExamPart(props: { task: Task; number: number; children: ReactNode }) {
  const { task, number } = props;
  const t = useT().homework;
  const heading = `exam-part-${task.id}`;
  return (
    <section aria-labelledby={heading} className="mt-14 border-t pt-9 first:mt-10">
      <p className="text-[11px] font-semibold tracking-[0.14em] text-subtle-foreground uppercase">
        {t.partEyebrow(number, formLabel(task.form, t))}
      </p>
      <h2
        id={heading}
        className="mt-1.5 font-serif text-[23px] leading-snug font-semibold tracking-tight text-balance"
      >
        {task.title ?? t.part(number)}
      </h2>
      <div className="mt-5 font-serif text-[17px] leading-[1.7] text-foreground">
        <Blocks blocks={task.blocks} />
      </div>
      <div className="mt-8">{props.children}</div>
    </section>
  );
}
