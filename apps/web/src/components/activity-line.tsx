import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { useT } from "@/i18n";
import type { Activity } from "@/lib/session";
import { StreamedText, useRevealedText } from "./streamed-text";
import { WorkingMark } from "./working-mark";
import { cn } from "@/lib/utils";
import { wordNotice } from "@/i18n/notice";

/**
 * What the tutor is doing right now, in one quiet line (the working mark, then the most recent
 * running activity, its label shimmering while it runs), with the model's reasoning behind a toggle when it shared any.
 * Shows `fallback` when nothing is reported yet but the learner is waiting.
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
  const all = useT();
  const t = all.session;
  const current = activities.at(-1);
  if (!current && !fallback) return null;
  const label = current ? wordNotice(current.label, all) : fallback;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("font-sans text-sm text-subtle-foreground", className)}
    >
      <div className="flex items-center gap-2">
        <WorkingMark className="text-muted-foreground" />
        <span className="text-shimmer text-muted-foreground mb-px">{label}</span>
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
            {open ? t.hideThinking : t.showThinking}
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
