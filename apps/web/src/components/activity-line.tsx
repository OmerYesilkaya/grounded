import { ChevronRight } from "lucide-react";
import { useState } from "react";
import type { Activity } from "@/lib/session";
import { StreamedText, useRevealedText } from "./streamed-text";
import { cn } from "@/lib/utils";

/**
 * What the tutor is doing right now, in one quiet line (the most recent running activity), with
 * the model's reasoning behind a toggle when it shared any. Shows `fallback` when nothing is
 * reported yet but the learner is waiting.
 */
export function ActivityLine({
  activities,
  fallback,
  className,
}: {
  activities: readonly Activity[];
  fallback?: string | undefined;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = activities.at(-1);
  if (!current && !fallback) return null;
  const label = current ? current.label : fallback;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("font-sans text-sm text-subtle-foreground", className)}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" />
          <span className="relative inline-flex size-2 rounded-full bg-primary" />
        </span>
        <span className="text-muted-foreground">{label}</span>
        {current?.detail && <span className="truncate">{current.detail}</span>}
        {current?.reasoning && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => {
              setOpen(!open);
            }}
            className="ml-1 inline-flex items-center gap-0.5 text-xs hover:text-muted-foreground"
          >
            <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
            {open ? "Hide thinking" : "Show thinking"}
          </button>
        )}
      </div>
      {open && current?.reasoning && <Reasoning key={current.id} text={current.reasoning} />}
    </div>
  );
}

/** The reasoning streams while its activity runs; the activity is gone once it is done. */
function Reasoning({ text }: { text: string }) {
  const revealed = useRevealedText(text, true);
  return (
    <StreamedText
      revealed={revealed}
      className="mt-2 max-h-48 overflow-y-auto border-l-2 pl-3 text-xs leading-relaxed"
    />
  );
}
