import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { finalQuery, type FinalOutcome, type FixListEntry } from "@/lib/final";
import { cn } from "@/lib/utils";

const Label = ({ children, className }: { children: ReactNode; className?: string }) => (
  <h3
    className={cn(
      "text-[11px] font-semibold tracking-[0.12em] text-subtle-foreground uppercase",
      className,
    )}
  >
    {children}
  </h3>
);

const dayOf = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

/**
 * The end of a track (design §7.4): what its final found. The fix-list kept along the way beside
 * the one the fresh audit found ("the difference between the two lists is the measurement"), and
 * where the chain of reasoning broke in the teach-back, in the learner's own words. Drawn by the
 * app from the records, next to the tutor's recap, which says what they mean.
 */
export function FinalOutcomeCard({
  sessionId,
  footer,
}: {
  sessionId: string;
  /** What comes next, at the card's foot. */
  footer?: ReactNode;
}) {
  const outcome = useQuery(finalQuery(sessionId));
  if (!outcome.data) return null;
  return <FinalOutcomeView outcome={outcome.data} footer={footer} />;
}

export function FinalOutcomeView({
  outcome,
  footer,
}: {
  outcome: FinalOutcome;
  footer?: ReactNode;
}) {
  const { before, found, breaks } = outcome;
  const fixed = before.filter((item) => !item.open).length;
  return (
    <section
      aria-labelledby="final-outcome"
      className="overflow-hidden rounded-xl border border-primary/30 bg-card"
    >
      <div className="px-5 pt-5 pb-4 sm:px-6">
        <p className="text-[11px] font-semibold tracking-[0.14em] text-primary uppercase">
          The final{outcome.closedAt ? ` · ${dayOf(outcome.closedAt)}` : ""}
        </p>
        <h2
          id="final-outcome"
          className="mt-1 flex items-center gap-2 font-serif text-2xl font-semibold tracking-tight"
        >
          <Check className="size-5 shrink-0 text-success" aria-hidden />
          Track finished
        </h2>
        <dl className="mt-4 grid grid-cols-3 border-y">
          <Figure value={before.length} label="found along the way" />
          <Figure value={fixed} label="fixed" good />
          <Figure value={found.length} label="found in the final" />
        </dl>
      </div>

      <div className="grid gap-x-8 gap-y-6 px-5 pb-5 sm:grid-cols-2 sm:px-6">
        <div>
          <Label>Along the way</Label>
          {before.length > 0 ? (
            <Items items={before} markOpen />
          ) : (
            <p className="mt-2 text-[14px] text-muted-foreground">Nothing was found to fix.</p>
          )}
        </div>
        <div>
          <Label>In the final</Label>
          {found.length > 0 ? (
            <Items items={found} />
          ) : (
            <p className="mt-2 flex gap-2 text-[14px] leading-relaxed text-muted-foreground">
              <Check className="mt-1 size-3.5 shrink-0 text-success" aria-hidden />
              Nothing new: the fresh audit found no misconception.
            </p>
          )}
        </div>
      </div>

      <div className="border-t px-5 py-5 sm:px-6">
        <Label>Where the chain broke</Label>
        {breaks.length > 0 ? (
          <>
            <ul className="mt-3 flex flex-col gap-3.5">
              {breaks.map((b, i) => (
                <li key={i} className="border-l-2 border-primary/50 pl-3.5">
                  {b.term && <p className="text-[12.5px] font-medium">{b.term}</p>}
                  <p className="font-serif text-[16px] leading-snug italic">“{b.quote}”</p>
                </li>
              ))}
            </ul>
            <p className="mt-3.5 text-[13px] leading-relaxed text-muted-foreground">
              Where you had to say “it just is”, the idea was remembered rather than built. Each is
              back among the ideas still settling, for a next session to rebuild.
            </p>
          </>
        ) : (
          <p className="mt-2 flex gap-2 text-[14px] leading-relaxed text-muted-foreground">
            <Check className="mt-1 size-3.5 shrink-0 text-success" aria-hidden />
            Nowhere: you gave a reason for every link.
          </p>
        )}
      </div>
      {footer && <div className="border-t bg-muted/40 px-5 py-4 sm:px-6">{footer}</div>}
    </section>
  );
}

function Items({ items, markOpen }: { items: readonly FixListEntry[]; markOpen?: boolean }) {
  return (
    <ul className="mt-2.5 flex flex-col gap-2">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2.5 text-[14px] leading-relaxed">
          {item.open ? (
            <span aria-hidden className="mt-[0.6rem] h-px w-3 shrink-0 bg-primary" />
          ) : (
            <Check className="mt-1 size-3.5 shrink-0 text-success" aria-hidden />
          )}
          <span className={cn(!item.open && "text-muted-foreground")}>
            {item.text}
            {item.open && markOpen ? (
              <span className="ml-2 text-[11px] whitespace-nowrap text-primary">still open</span>
            ) : (
              <span className="sr-only">{item.open ? " (open)" : " (fixed)"}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Figure({ value, label, good }: { value: number; label: string; good?: boolean }) {
  return (
    <div className="flex flex-col-reverse py-3.5 pr-2 not-first:border-l not-first:pl-4">
      <dt className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "font-serif text-3xl font-semibold tracking-tight tabular-nums",
          good && value > 0 && "text-success",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
