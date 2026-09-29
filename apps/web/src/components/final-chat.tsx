import type { SessionPhase } from "@grounded/core";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/** The final's parts, in order (design §7.4), as the learner reads them. */
const PARTS = ["Fresh audit", "Teach-back", "What it found"] as const;

/** Which part the final is in: none yet while its review looks back, the last once it closes. */
const partOf = (phase: SessionPhase) =>
  phase === "audit"
    ? 0
    : phase === "teach-back"
      ? 1
      : phase === "close" || phase === "closed"
        ? 2
        : -1;

/**
 * Where the final stands, in the session's bar where a normal session has its Chat / Lesson
 * switch (a final has no lesson): its parts in order, the current one marked. On a phone, only
 * the current one.
 */
export function FinalParts({ phase }: { phase: SessionPhase }) {
  const current = partOf(phase);
  const done = phase === "closed";
  return (
    <div className="flex min-w-0 items-center gap-3 text-[12.5px]">
      <span className="shrink-0 text-[11px] font-semibold tracking-[0.14em] text-primary uppercase">
        The final
      </span>
      <ol className="flex min-w-0 items-center gap-1" aria-label="Its parts">
        {PARTS.map((part, i) => {
          const passed = i < current || (done && i === current);
          const here = i === current && !done;
          return (
            <li
              key={part}
              aria-current={here ? "step" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 whitespace-nowrap",
                here ? "bg-muted text-foreground" : "text-subtle-foreground",
                // On a phone, the part it is in (or, closed, the last).
                i !== Math.max(current, 0) && "max-sm:hidden",
              )}
            >
              {passed ? (
                <Check className="size-3 text-success" aria-hidden />
              ) : (
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 rounded-full",
                    here ? "bg-primary" : "border border-border-strong",
                  )}
                />
              )}
              {part}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The top of the final's chat: what it is. */
export function FinalIntro() {
  return (
    <div className="flex flex-col gap-1.5">
      <h2 className="text-[11px] font-semibold tracking-[0.14em] text-primary uppercase">
        The final
      </h2>
      <p className="font-serif text-[17px] leading-relaxed text-muted-foreground">
        Two parts and no homework. A fresh audit of where you stand across the whole subject, then a
        teach-back: you rebuild it from its foundations, and the tutor keeps asking why and what if.
        Answer in your own words; there is nothing to look up.
      </p>
    </div>
  );
}
