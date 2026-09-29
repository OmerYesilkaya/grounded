import { Outlet } from "@tanstack/react-router";
import { useMediaQuery } from "@/lib/media-query";
import { HomeworkReminder } from "./homework-reminder";
import { SIDEBAR_SHOWN, TrackDrawer } from "./track-drawer";
import { TrackSidebar } from "./track-sidebar";

export function AppShell({ email }: { email: string }) {
  // Where the track list isn't a column, it is a drawer, opened from the page's bar (design §9.4).
  const column = useMediaQuery(SIDEBAR_SHOWN, true);
  return (
    <TrackDrawer email={email}>
      <div className="flex min-h-dvh">
        {column && <TrackSidebar email={email} className="sticky top-0 h-dvh w-[248px] shrink-0" />}
        <div className="flex min-w-0 flex-1 flex-col">
          <Outlet />
        </div>
        <HomeworkReminder />
      </div>
    </TrackDrawer>
  );
}
