import { Link } from "@tanstack/react-router";
import { Check, ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useFormat, useT } from "@/i18n";
import { dueLabel, tagOf, useNow } from "@/lib/snooze";
import { describeItem } from "@/lib/track-list";
import { isAssigned, isDue, type TrackItem, type TrackSummary } from "@/lib/tracks";
import { cn } from "@/lib/utils";
import { SourceMarker } from "./track-source";

/**
 * One track in the track list (design §9.2): its name as the parent line, and when expanded its
 * items below it, hung from a thread line that marks where they belong. The current session is where
 * the thread turns to the accent colour; finished items fold into one line. While searching, the
 * items found are shown, unfolded.
 */
export function TrackGroup(props: {
  track: TrackSummary;
  /** The page shows this track or something in it. */
  current: boolean;
  /** The item the page shows, if any. */
  currentItemId: string | undefined;
  expanded: boolean;
  onToggle: () => void;
  /** Searching, and these are the track's items that match (its name didn't). */
  found?: TrackItem[] | undefined;
  /** Shown at the end of the track's line: its menu. */
  actions?: ReactNode;
}) {
  const { track, current, currentItemId, expanded, onToggle } = props;
  const now = useNow();
  const t = useT().sidebar;
  const waiting = track.items.filter((item) => !item.done).length;
  // Homework or an exam whose snooze ran out is what is waiting most (design §9.2).
  const due = track.items.filter((item) => isDue(item, now)).length;
  return (
    <li>
      <div className="group/track flex items-center rounded-md hover:bg-accent/60">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? t.hide(track.title) : t.show(track.title)}
          onClick={onToggle}
          className="touch-target relative flex size-7 shrink-0 items-center justify-center rounded-md text-subtle-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <ChevronRight
            className={cn(
              "size-3.5 transition-transform motion-reduce:transition-none",
              expanded && "rotate-90",
              current && "text-primary",
            )}
          />
        </button>
        <Link
          to="/tracks/$trackId"
          params={{ trackId: track.id }}
          aria-current={current ? "true" : undefined}
          className={cn(
            "min-w-0 flex-1 truncate py-1.5 pr-1 font-serif pointer-coarse:py-2.5 text-[15px] leading-snug font-semibold tracking-tight outline-none focus-visible:underline",
            current ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
          title={track.title}
        >
          {track.source && <SourceMarker className="mr-1.5 inline align-[-2px]" />}
          {track.title}
        </Link>
        {/* What is waiting, while the items aren't shown; the menu takes its place on hover. With
            nothing open, the final offered, or the track finished (design §9.2). */}
        {!expanded && (waiting > 0 || track.final === "ready" || track.final === "finished") && (
          <span
            className={cn(
              "flex shrink-0 items-center gap-1 pr-2 text-[11px] text-subtle-foreground group-focus-within/track:hidden group-hover/track:hidden group-has-data-[state=open]/track:hidden",
              (due > 0 || (waiting === 0 && track.final === "ready")) && "font-medium text-primary",
            )}
          >
            {waiting > 0 ? (
              due > 0 ? (
                t.due(due)
              ) : (
                t.open(waiting)
              )
            ) : track.final === "ready" ? (
              t.finalReady
            ) : (
              <>
                <Check className="size-3 text-success" aria-hidden />
                {t.finished}
              </>
            )}
          </span>
        )}
        {props.actions}
      </div>
      {props.found ? (
        <ItemList track={track}>
          {props.found.map((item) => (
            <ItemRow key={item.id} item={item} currentItemId={currentItemId} />
          ))}
        </ItemList>
      ) : (
        expanded && <TrackItems track={track} currentItemId={currentItemId} />
      )}
    </li>
  );
}

function TrackItems({
  track,
  currentItemId,
}: {
  track: TrackSummary;
  currentItemId: string | undefined;
}) {
  const done = track.items.filter((item) => item.done);
  const rest = track.items.filter((item) => !item.done);
  // The item on the page is never folded away.
  const [showDone, setShowDone] = useState(false);
  const t = useT().sidebar;
  const doneShown = showDone || done.some((item) => item.id === currentItemId);

  return (
    <ItemList track={track}>
      {done.length > 0 && (
        <li>
          <button
            type="button"
            aria-expanded={doneShown}
            onClick={() => {
              setShowDone(!doneShown);
            }}
            className="flex items-center gap-1 py-1 pl-3 text-[11.5px] pointer-coarse:py-2.5 text-subtle-foreground outline-none hover:text-foreground focus-visible:underline"
          >
            {t.done(done.length)}
            <ChevronRight
              className={cn(
                "size-3 transition-transform motion-reduce:transition-none",
                doneShown && "rotate-90",
              )}
            />
          </button>
        </li>
      )}
      {doneShown &&
        done.map((item) => <ItemRow key={item.id} item={item} currentItemId={currentItemId} />)}
      {rest.map((item) => (
        <ItemRow key={item.id} item={item} currentItemId={currentItemId} />
      ))}
      {track.items.length === 0 && (
        <li className="py-1 pl-3 text-[12.5px] text-subtle-foreground">{t.empty}</li>
      )}
    </ItemList>
  );
}

/** The thread line sits under the chevron's centre, tying the items to their track. */
function ItemList({ track, children }: { track: TrackSummary; children: ReactNode }) {
  const t = useT().sidebar;
  return (
    <ul className="mt-0.5 mb-2 ml-3.5 border-l" aria-label={t.within(track.title)}>
      {children}
    </ul>
  );
}

/** Where an item's row goes: its session, or the page of its homework or exam. */
export const itemLink = (item: TrackItem) =>
  isAssigned(item)
    ? ({ to: "/homework/$assignmentId", params: { assignmentId: item.id } } as const)
    : ({ to: "/sessions/$sessionId", params: { sessionId: item.id } } as const);

function ItemRow({ item, currentItemId }: { item: TrackItem; currentItemId: string | undefined }) {
  const current = item.id === currentItemId;
  const { title, meta } = describeItem(item, useT());
  return (
    <li>
      <Link
        {...itemLink(item)}
        aria-current={current ? "page" : undefined}
        className={cn(
          // The accent segment is drawn over the thread line, beside the item it marks.
          "relative -ml-px block border-l border-transparent py-1 pr-2 pl-3 outline-none pointer-coarse:py-2 focus-visible:bg-accent/60",
          current
            ? "border-primary text-foreground"
            : "text-muted-foreground hover:border-border-strong hover:text-foreground",
          item.done && !current && "text-subtle-foreground",
        )}
      >
        <span className="flex items-start gap-1.5">
          <span className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-snug" title={title}>
            {title}
          </span>
          {isAssigned(item) && !item.done && item.due && <DueTag due={item.due} />}
        </span>
        <span className="block text-[10px] leading-snug tracking-widest text-subtle-foreground uppercase">
          {meta}
        </span>
      </Link>
    </li>
  );
}

/** When homework or an exam put off is due (design §9.2): "tonight", "tomorrow"; "due" once it is. */
export function DueTag({ due }: { due: string }) {
  const now = useNow();
  const t = useT();
  const format = useFormat();
  const tag = tagOf(due, now);
  return (
    <span
      className={cn(
        "mt-px shrink-0 rounded-[3px] px-1 py-px text-[10px] leading-snug",
        tag === "due" ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary",
      )}
    >
      {dueLabel(due, now, t, format)}
    </span>
  );
}
