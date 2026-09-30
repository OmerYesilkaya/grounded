import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { useT } from "@/i18n";
import type { AssignmentSummary } from "@/lib/assignments";

/**
 * Where the review that opens a session starts in the chat (design §7.1): what it looks back on,
 * each piece of work linked to its page, where the comments in its margin are.
 */
export function ReviewHeading({ takenUp }: { takenUp: readonly AssignmentSummary[] }) {
  const t = useT().session.review;
  return (
    <div className="flex flex-col gap-2.5">
      <h2 className="text-[11px] font-normal tracking-widest text-primary uppercase">
        {t.sinceLastTime}
      </h2>
      {takenUp.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {takenUp.map((work) => (
            <li key={work.id} className="min-w-0">
              <Link
                to="/homework/$assignmentId"
                params={{ assignmentId: work.id }}
                className="touch-target relative flex max-w-full items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-[13px] transition-colors hover:border-primary/40 hover:text-primary"
              >
                <span className="shrink-0 text-subtle-foreground">
                  {work.kind === "exam" ? t.exam : t.homework}
                </span>
                <span className="truncate">{work.title}</span>
                <ArrowUpRight className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Where the review hands over to the probe: this session's own ground begins. */
export function ReviewDone() {
  return <ChatRule label={useT().session.review.thisSession} />;
}

/** A quiet rule across the chat where a new part of the session begins. */
export function ChatRule({ label }: { label: string }) {
  return (
    <div
      role="separator"
      aria-label={label}
      className="flex items-center gap-3 py-1 text-[11px] tracking-widest text-subtle-foreground uppercase"
    >
      <span className="h-px flex-1 bg-border" aria-hidden />
      {label}
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  );
}
