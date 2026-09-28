import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import { describeItem } from "@/lib/track-list";
import type { TrackItem, TrackSummary } from "@/lib/tracks";
import { cn } from "@/lib/utils";

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
  const waiting = track.items.filter((item) => !item.done).length;
  return (
    <li>
      <div className="group/track flex items-center rounded-md hover:bg-accent/60">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} what is in ${track.title}`}
          onClick={onToggle}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-subtle-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
            "min-w-0 flex-1 truncate py-1.5 pr-1 font-serif text-[15px] leading-snug font-semibold tracking-tight outline-none focus-visible:underline",
            current ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
          title={track.title}
        >
          {track.title}
        </Link>
        {/* What is waiting, while the items aren't shown; the menu takes its place on hover. */}
        {!expanded && waiting > 0 && (
          <span className="shrink-0 pr-2 text-[11px] text-subtle-foreground group-focus-within/track:hidden group-hover/track:hidden">
            {waiting} open
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
            className="flex items-center gap-1 py-1 pl-3 text-[11.5px] text-subtle-foreground outline-none hover:text-foreground focus-visible:underline"
          >
            {done.length} done
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
        <li className="py-1 pl-3 text-[12.5px] text-subtle-foreground">Nothing here yet</li>
      )}
    </ItemList>
  );
}

/** The thread line sits under the chevron's centre, tying the items to their track. */
function ItemList({ track, children }: { track: TrackSummary; children: ReactNode }) {
  return (
    <ul className="mt-0.5 mb-2 ml-3.5 border-l" aria-label={`In ${track.title}`}>
      {children}
    </ul>
  );
}

function ItemRow({ item, currentItemId }: { item: TrackItem; currentItemId: string | undefined }) {
  const current = item.id === currentItemId;
  const { title, meta } = describeItem(item);
  return (
    <li>
      <Link
        to="/sessions/$sessionId"
        params={{ sessionId: item.id }}
        aria-current={current ? "page" : undefined}
        className={cn(
          // The accent segment is drawn over the thread line, beside the item it marks.
          "relative -ml-px block border-l border-transparent py-1 pr-2 pl-3 outline-none focus-visible:bg-accent/60",
          current
            ? "border-primary text-foreground"
            : "text-muted-foreground hover:border-border-strong hover:text-foreground",
          item.done && !current && "text-subtle-foreground",
        )}
      >
        <span className="line-clamp-2 text-[13px] leading-snug" title={title}>
          {title}
        </span>
        <span className="block text-[10px] leading-snug tracking-widest text-subtle-foreground uppercase">
          {meta}
        </span>
      </Link>
    </li>
  );
}
