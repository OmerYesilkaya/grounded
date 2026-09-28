import { Link, useParams } from "@tanstack/react-router";
import { useTracks } from "@/lib/tracks";
import { AccountMenu } from "./account-menu";
import { cn } from "@/lib/utils";

const PHASE_LABEL: Record<string, string> = {
  probe: "Session · getting started",
  plan: "Session · planning",
  lesson: "Session · lesson",
  homework: "Session · homework",
  close: "Session · wrapping up",
};

/** The track list: the "typographic index" from the prototype (design §9.2). */
export function TrackSidebar({ email }: { email: string }) {
  const tracks = useTracks();
  const params = useParams({ strict: false });

  return (
    <aside className="sticky top-0 flex h-screen w-[248px] shrink-0 flex-col border-r bg-background max-md:hidden">
      {/* As tall as the session's Chat / Lesson bar, so the two read as one header band. */}
      <div className="flex h-13 shrink-0 items-center border-b px-3.5">
        <Link to="/" className="font-brand text-lg leading-none text-primary">
          Grounded
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
      <nav aria-label="Tracks" className="flex-1 overflow-auto px-3.5 pt-1.5 pb-4">
        {tracks.data?.map((track) => {
          const current =
            params.trackId === track.id ||
            (track.openSession !== null && params.sessionId === track.openSession.id);
          return (
            <section key={track.id} className="border-t first:border-t-0">
              <Link
                to="/tracks/$trackId"
                params={{ trackId: track.id }}
                className={cn(
                  "block truncate py-2.5 font-serif text-[15.5px] font-semibold tracking-tight text-muted-foreground hover:text-foreground",
                  current && "text-[17px] text-foreground",
                )}
              >
                {track.title}
              </Link>
              {track.openSession && (
                <Link
                  to="/sessions/$sessionId"
                  params={{ sessionId: track.openSession.id }}
                  className={cn(
                    "mb-2 block border-t py-1.5 text-[13.5px] text-muted-foreground hover:text-foreground",
                    params.sessionId === track.openSession.id &&
                      "-ml-2.5 pl-2.5 font-medium text-foreground shadow-[inset_2px_0_0_var(--primary)]",
                  )}
                >
                  <span className="block text-[10px] tracking-widest text-subtle-foreground uppercase">
                    {PHASE_LABEL[track.openSession.phase] ?? "Session"}
                  </span>
                  Continue
                </Link>
              )}
            </section>
          );
        })}
        {tracks.data?.length === 0 && (
          <p className="py-2.5 text-[12.5px] text-subtle-foreground">No tracks yet.</p>
        )}
      </nav>
      <div className="shrink-0 border-t px-1.5 py-1.5">
        <AccountMenu email={email} />
      </div>
    </aside>
  );
}
