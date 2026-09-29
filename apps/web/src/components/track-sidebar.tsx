import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { MANY_TRACKS, searchTracks, shortList } from "@/lib/track-list";
import { useTracks } from "@/lib/tracks";
import { cn } from "@/lib/utils";
import { AccountMenu } from "./account-menu";
import { Brand } from "./brand";
import { itemLink, TrackGroup } from "./track-list";
import { TrackMenu } from "./track-menu";

/**
 * The track list: the "typographic index" from the prototype (design §9.2). A column beside the
 * page, or on a phone the same list in a drawer (`TrackDrawer`), which puts its close button at the
 * end of the header.
 */
export function TrackSidebar({
  email,
  className,
  headerEnd,
}: {
  email: string;
  className?: string;
  headerEnd?: ReactNode;
}) {
  const tracks = useTracks();
  const params = useParams({ strict: false });
  const navigate = useNavigate();
  // Tracks the learner opened or closed by hand; the rest follow the page (its track is open).
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);

  // "/" jumps to the search from anywhere but a place where "/" is being typed.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")
      )
        return;
      event.preventDefault();
      search.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const all = tracks.data ?? [];
  // The item the page shows: a session, or a homework.
  const pageItemId = params.sessionId ?? params.assignmentId;
  const currentTrackId =
    params.trackId ?? all.find((t) => t.items.some((item) => item.id === pageItemId))?.id;
  const searching = query.trim() !== "";
  const found = searching ? searchTracks(all, query) : null;
  const { shown, hidden } = shortList(all, currentTrackId, showAll);
  const rows = found ?? shown.map((track) => ({ track, items: null }));

  /** Enter opens the first thing found: an item, or a track found by its name. */
  const openFirst = () => {
    const [first] = found ?? [];
    if (!first) return;
    const item = first.items?.[0];
    if (item) void navigate(itemLink(item));
    else void navigate({ to: "/tracks/$trackId", params: { trackId: first.track.id } });
    setQuery("");
    search.current?.blur();
  };

  return (
    <aside className={cn("flex flex-col border-r bg-background", className)}>
      {/* As tall as the page's bar (PageBar), so the two read as one header band. */}
      <div className="flex h-13 shrink-0 items-center border-b px-3.5">
        <Link to="/">
          <Brand className="text-lg" />
        </Link>
        {headerEnd}
      </div>
      <div className="flex flex-col gap-2 px-3.5 pt-3.5 pb-2">
        <Link
          to="/tracks/new"
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-ring bg-highlight px-2.5 py-2 pointer-coarse:py-2.5 text-[13px] font-medium text-primary hover:border-solid"
        >
          + New track
        </Link>
        <label className="flex h-8 items-center gap-2 rounded-md border px-2.5 text-subtle-foreground pointer-coarse:h-10 focus-within:border-border-strong focus-within:text-foreground">
          <Search aria-hidden className="size-3.5 shrink-0" />
          <input
            ref={search}
            type="search"
            aria-label="Search tracks and lessons"
            placeholder="Search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                openFirst();
              } else if (event.key === "Escape") {
                setQuery("");
                event.currentTarget.blur();
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none pointer-coarse:text-base placeholder:text-subtle-foreground [&::-webkit-search-cancel-button]:hidden"
          />
          {!searching && (
            <kbd className="rounded-[3px] border px-1 font-sans pointer-coarse:hidden text-[10.5px] leading-4 text-subtle-foreground">
              /
            </kbd>
          )}
        </label>
      </div>
      <nav aria-label="Tracks" className="flex-1 overflow-auto px-2 pt-1 pb-4">
        <ul className="flex flex-col gap-0.5">
          {rows.map(({ track, items }) => {
            const currentItem = track.items.find((item) => item.id === pageItemId);
            const current = track.id === currentTrackId;
            const expanded = items !== null || (toggled[track.id] ?? current);
            return (
              <TrackGroup
                key={track.id}
                track={track}
                current={current}
                currentItemId={currentItem?.id}
                expanded={expanded}
                found={items ?? undefined}
                actions={<TrackMenu track={track} current={current} />}
                onToggle={() => {
                  setToggled((was) => ({ ...was, [track.id]: !expanded }));
                }}
              />
            );
          })}
        </ul>
        {!searching && all.length >= MANY_TRACKS && (
          <button
            type="button"
            aria-expanded={showAll}
            onClick={() => {
              setShowAll(!showAll);
            }}
            className="mt-1.5 px-2 py-1 text-[12px] text-subtle-foreground outline-none hover:text-foreground focus-visible:underline"
          >
            {showAll ? "Fewer tracks" : `${String(hidden)} more tracks`}
          </button>
        )}
        {found?.length === 0 && (
          <p className="px-2 py-2 text-[12.5px] text-subtle-foreground">
            Nothing matches &ldquo;{query.trim()}&rdquo;.
          </p>
        )}
        {tracks.data?.length === 0 && (
          <p className="px-2 py-2.5 text-[12.5px] text-subtle-foreground">No tracks yet.</p>
        )}
      </nav>
      <div className="shrink-0 border-t px-1.5 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]">
        <AccountMenu email={email} />
      </div>
    </aside>
  );
}
