import type { ChecklistItem } from "@grounded/core/assignment";
import { Check } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

const storageKey = (assignmentId: string) => `grounded:self-check:${assignmentId}`;

/** The items ticked on this browser: the learner's own check, which nothing else reads. */
function readTicked(assignmentId: string): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey(assignmentId)) ?? "[]") as unknown;
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeTicked(assignmentId: string, ticked: readonly string[]): void {
  try {
    localStorage.setItem(storageKey(assignmentId), JSON.stringify(ticked));
  } catch {
    // Private mode or blocked storage: the ticks last as long as the page.
  }
}

/** The items the learner has ticked, remembered on this browser. */
export function useSelfCheck(assignmentId: string) {
  const [ticked, setTicked] = useState(() => readTicked(assignmentId));
  const toggle = (id: string) => {
    const next = ticked.includes(id) ? ticked.filter((t) => t !== id) : [...ticked, id];
    setTicked(next);
    writeTicked(assignmentId, next);
  };
  return { ticked, toggle };
}

/**
 * "What a good answer demonstrates" (method.md, "Homework"): the learner ticks off what their
 * answer shows before they hand it in. A self-check, not a score; the review marks each item.
 */
export function SelfCheck(props: {
  items: readonly ChecklistItem[];
  ticked: readonly string[];
  onToggle: (id: string) => void;
  /** Handed in: the list is shown, the ticks stay as they were. */
  readOnly: boolean;
}) {
  const { ticked } = props;
  if (props.items.length === 0) return null;
  return (
    <section aria-labelledby="self-check" className="rounded-xl border bg-card px-4 py-3.5">
      <h2
        id="self-check"
        className="text-[11px] font-semibold tracking-[0.12em] text-subtle-foreground uppercase"
      >
        A good answer shows
      </h2>
      <ul className="mt-2.5 flex flex-col gap-1.5">
        {props.items.map((item) => {
          const on = ticked.includes(item.id);
          return (
            <li key={item.id}>
              <label
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-md py-1 text-[13.5px] leading-snug",
                  props.readOnly && "cursor-default",
                )}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={props.readOnly}
                  onChange={() => {
                    props.onToggle(item.id);
                  }}
                  className="peer sr-only"
                />
                <span
                  aria-hidden
                  className={cn(
                    "mt-px flex size-4 shrink-0 items-center justify-center rounded border border-border-strong transition-colors peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50",
                    on && "border-primary bg-primary text-primary-foreground",
                  )}
                >
                  {on && <Check className="size-3" strokeWidth={3} />}
                </span>
                <span className={cn(on ? "text-muted-foreground" : "text-foreground")}>
                  {item.text}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {!props.readOnly && (
        <p className="mt-2.5 text-[12px] leading-snug text-subtle-foreground">
          Tick what your answer shows before you hand it in. Only you see the ticks.
        </p>
      )}
    </section>
  );
}
