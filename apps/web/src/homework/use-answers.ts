import type { Answers, TaskAnswer } from "@grounded/core/assignment";
import { useCallback, useEffect, useRef, useState } from "react";
import { assignmentApi, type Assignment } from "@/lib/assignments";

/** How long after the last keystroke an answer is saved. */
export const SAVE_AFTER_MS = 800;

export type SaveStatus = "saved" | "saving" | "failed";

const EMPTY: TaskAnswer = { fields: {}, lockedAt: null };

/**
 * The learner's answers as they write them: kept here, saved a moment after they stop typing
 * (one task at a time, in order), and saved at once before a prediction is locked or the whole
 * thing is handed in.
 */
export function useAnswers(assignment: Assignment) {
  const [answers, setAnswers] = useState<Answers>(assignment.answers);
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [error, setError] = useState<string | null>(null);
  // What each task's answer is now, and which tasks have changes not saved yet.
  const current = useRef<Answers>(assignment.answers);
  const unsaved = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saving = useRef<Promise<void>>(Promise.resolve());

  const put = (taskId: string, answer: TaskAnswer) => {
    current.current = { ...current.current, [taskId]: answer };
    setAnswers(current.current);
  };

  /** Saves every task with changes, after any save already under way. */
  const flush = useCallback((): Promise<void> => {
    clearTimeout(timer.current);
    const run = saving.current.then(async () => {
      const tasks = [...unsaved.current];
      unsaved.current.clear();
      if (tasks.length === 0) return;
      setStatus("saving");
      try {
        for (const taskId of tasks) {
          const fields = current.current[taskId]?.fields ?? {};
          await assignmentApi.save(assignment.id, taskId, fields);
        }
        setStatus(unsaved.current.size ? "saving" : "saved");
        setError(null);
      } catch (failed) {
        // Kept to be saved again with the next change or the next try.
        for (const taskId of tasks) unsaved.current.add(taskId);
        setStatus("failed");
        setError(failed instanceof Error ? failed.message : "Your answer wasn't saved.");
        throw failed;
      }
    });
    saving.current = run.catch(() => undefined);
    return run;
  }, [assignment.id]);

  const change = (taskId: string, key: string, value: string) => {
    const answer = current.current[taskId] ?? EMPTY;
    put(taskId, { ...answer, fields: { ...answer.fields, [key]: value } });
    unsaved.current.add(taskId);
    setStatus("saving");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      flush().catch(() => undefined);
    }, SAVE_AFTER_MS);
  };

  /** Predict → verify: saves the prediction, then locks it with the time. */
  const lock = async (taskId: string) => {
    try {
      await flush();
      put(taskId, await assignmentApi.lock(assignment.id, taskId));
      setError(null);
    } catch (failed) {
      setError(failed instanceof Error ? failed.message : "Your prediction wasn't locked.");
    }
  };

  // Leaving the page saves what is still waiting.
  useEffect(
    () => () => {
      if (unsaved.current.size) flush().catch(() => undefined);
    },
    [flush],
  );

  return { answers, status, error, setError, change, lock, flush };
}
