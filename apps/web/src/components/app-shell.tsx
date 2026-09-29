import { Outlet } from "@tanstack/react-router";
import { HomeworkReminder } from "./homework-reminder";
import { TrackSidebar } from "./track-sidebar";

export function AppShell({ email }: { email: string }) {
  return (
    <div className="flex min-h-screen">
      <TrackSidebar email={email} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
      <HomeworkReminder />
    </div>
  );
}
