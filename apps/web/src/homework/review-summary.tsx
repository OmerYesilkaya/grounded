import type { ChecklistItem } from "@grounded/core/assignment";
import type { ReviewMark } from "@grounded/core/assignment-review";
import { Check, Droplet, Minus, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { WorkingMark } from "@/components/working-mark";
import { cn } from "@/lib/utils";
import type { LiveReview } from "./use-review";

/** Each mark's word, icon, and colours: of its badge, and of its word. */
const MARKS: Record<
  ReviewMark,
  { label: string; icon: typeof Check; badge: string; word: string }
> = {
  held: { label: "Held", icon: Check, badge: "bg-success/15 text-success", word: "text-success" },
  leaked: {
    label: "Leaked",
    icon: Droplet,
    badge: "bg-primary/15 text-primary",
    word: "text-primary",
  },
  missing: {
    label: "Missing",
    icon: Minus,
    badge: "bg-muted text-muted-foreground",
    word: "text-foreground",
  },
};

const Heading = ({ children }: { children: string }) => (
  <h2 className="text-[11px] font-semibold tracking-[0.12em] text-subtle-foreground uppercase">
    {children}
  </h2>
);

/**
 * The review's summary above the answer (design §7.4): while it is under way, that it is; if it
 * failed, why, and a way to start it again; once done, "what a good answer demonstrates" with each
 * item marked held, leaked or missing, never a score. A leaked item leads to its comment.
 */
export function ReviewSummary(props: {
  review: LiveReview;
  checklist: readonly ChecklistItem[];
  /** Opens the first comment on this item, in the margin or under its field. */
  onShowComment: (itemId: string) => void;
  onAgain: () => Promise<void>;
}) {
  const { review, checklist } = props;
  if (review.status === "reviewing")
    return (
      <section
        aria-live="polite"
        className="rounded-xl border bg-card px-4 py-3.5 [--mark-surface:var(--card)]"
      >
        <Heading>The review</Heading>
        <div className="mt-2.5 flex items-center gap-2 text-[14px] text-muted-foreground">
          <WorkingMark />
          <span className="text-shimmer mb-px">Reviewing your answer…</span>
        </div>
        <p className="mt-1.5 text-[12.5px] leading-snug text-subtle-foreground">
          Its comments will appear beside your answer, each on the words it is about.
        </p>
      </section>
    );
  if (review.status === "failed")
    return <Failed failure={review.failure} onAgain={props.onAgain} />;

  const open = review.comments.filter((c) => c.resolvedAt === null).length;
  const commented = new Set(review.comments.flatMap((c) => c.items));
  return (
    <section aria-labelledby="review-heading" className="rounded-xl border bg-card px-4 py-3.5">
      <div id="review-heading">
        <Heading>What your answer shows</Heading>
      </div>
      <ul className="mt-3 flex flex-col gap-3">
        {checklist.map((item) => {
          const marked = review.checklist.find((m) => m.id === item.id);
          const mark = marked ? MARKS[marked.mark] : null;
          const Icon = mark?.icon ?? Minus;
          return (
            <li key={item.id} className="flex items-start gap-3">
              <span
                aria-hidden
                className={cn(
                  "mt-px flex size-5 shrink-0 items-center justify-center rounded-full",
                  mark?.badge ?? "bg-muted text-subtle-foreground",
                )}
              >
                <Icon className="size-3" strokeWidth={3} />
              </span>
              <div className="min-w-0 text-[13.5px] leading-snug">
                <p className="text-foreground">{item.text}</p>
                {mark && (
                  <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                    <span className={cn("font-medium", mark.word)}>{mark.label}</span>
                    {marked?.note && <> · {marked.note}</>}
                    {commented.has(item.id) && (
                      <>
                        {" · "}
                        <button
                          type="button"
                          onClick={() => {
                            props.onShowComment(item.id);
                          }}
                          className="font-medium text-primary underline-offset-2 hover:underline"
                        >
                          See the comment
                        </button>
                      </>
                    )}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-3.5 border-t pt-3 text-[12.5px] leading-snug text-subtle-foreground">
        {review.comments.length === 0
          ? "No comments: nothing in your answer leaked."
          : open === 0
            ? "You found every flaw the comments pointed at."
            : `${String(open)} ${open === 1 ? "comment asks" : "comments ask"} you to look again at your answer: find the flaw, and reply in the card.`}
      </p>
    </section>
  );
}

function Failed(props: { failure: string | null; onAgain: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section role="alert" className="rounded-xl border bg-card px-4 py-3.5">
      <Heading>The review</Heading>
      <p className="mt-2 text-[14px] text-foreground">
        The review didn&apos;t go through. {props.failure}
      </p>
      <div className="mt-3 flex items-center gap-3">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            props
              .onAgain()
              .catch((failed: unknown) => {
                setError(failed instanceof Error ? failed.message : "That didn't go through.");
              })
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          <RotateCcw aria-hidden /> Review it again
        </Button>
        {error && <span className="text-[12.5px] text-destructive">{error}</span>}
      </div>
    </section>
  );
}
