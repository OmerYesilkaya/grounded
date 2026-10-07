import { Outlet } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useMediaQuery } from "@/lib/media-query";
import { HomeworkReminder } from "./homework-reminder";
import { SIDEBAR_SHOWN, TrackDrawer } from "./track-drawer";
import { TrackSidebar } from "./track-sidebar";

// Dev-only (design §10); the dynamic import is dropped from production builds with the DEV branch.
const TermStates = import.meta.env.DEV
  ? lazy(() => import("@/dev/term-states").then((m) => ({ default: m.TermStates })))
  : null;

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
        {TermStates && (
          <Suspense>
            <TermStates />
          </Suspense>
        )}
      </div>
    </TrackDrawer>
  );
}
