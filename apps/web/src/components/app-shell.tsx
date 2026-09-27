import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { TrackSidebar } from "./track-sidebar";

export function AppShell({ email }: { email: string }) {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-screen">
      <TrackSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
      <div className="fixed bottom-3 left-3 flex items-center gap-1 text-xs text-subtle-foreground max-md:hidden">
        <span className="max-w-[120px] truncate" title={email}>
          {email}
        </span>
        <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
          <Link to="/settings/key">Key</Link>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => {
            void authClient.signOut().then(() => navigate({ to: "/sign-in" }));
          }}
        >
          Sign out
        </Button>
      </div>
    </div>
  );
}
