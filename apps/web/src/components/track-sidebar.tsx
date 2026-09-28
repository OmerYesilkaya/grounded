import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useTracks } from "@/lib/tracks";
import { AccountMenu } from "./account-menu";
import { Brand } from "./brand";
import { TrackGroup } from "./track-list";

/** The track list: the "typographic index" from the prototype (design §9.2). */
export function TrackSidebar({ email }: { email: string }) {
  const tracks = useTracks();
  const params = useParams({ strict: false });
  // Tracks the learner opened or closed by hand; the rest follow the page (its track is open).
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  return (
    <aside className="sticky top-0 flex h-screen w-[248px] shrink-0 flex-col border-r bg-background max-md:hidden">
      {/* As tall as the session's Chat / Lesson bar, so the two read as one header band. */}
      <div className="flex h-13 shrink-0 items-center border-b px-3.5">
        <Link to="/">
          <Brand className="text-lg" />
        </Link>
      </div>
      <div className="flex flex-col gap-2.5 px-3.5 pt-3.5 pb-2.5">
        <Link
          to="/tracks/new"
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-ring bg-highlight px-2.5 py-2 text-[13px] font-medium text-primary hover:border-solid"
        >
          + New track
        </Link>
      </div>
      <nav aria-label="Tracks" className="flex-1 overflow-auto px-2 pt-1.5 pb-4">
        <ul className="flex flex-col gap-0.5">
          {tracks.data?.map((track) => {
            const currentItem = track.items.find((item) => item.id === params.sessionId);
            const current = params.trackId === track.id || currentItem !== undefined;
            const expanded = toggled[track.id] ?? current;
            return (
              <TrackGroup
                key={track.id}
                track={track}
                current={current}
                currentItemId={currentItem?.id}
                expanded={expanded}
                onToggle={() => {
                  setToggled((all) => ({ ...all, [track.id]: !expanded }));
                }}
              />
            );
          })}
        </ul>
        {tracks.data?.length === 0 && (
          <p className="px-1.5 py-2.5 text-[12.5px] text-subtle-foreground">No tracks yet.</p>
        )}
      </nav>
      <div className="shrink-0 border-t px-1.5 py-1.5">
        <AccountMenu email={email} />
      </div>
    </aside>
  );
}
