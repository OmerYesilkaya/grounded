import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { CentredPage } from "./auth-layout";

/** Placeholder until tracks and sessions arrive (order of work, step 5). */
export function HomePage({ email }: { email: string }) {
  const navigate = useNavigate();
  return (
    <CentredPage>
      <p className="text-sm text-muted-foreground">Signed in as {email}.</p>
      <p className="mt-2 text-sm text-muted-foreground">Tracks and sessions come next.</p>
      <div className="mt-6 flex gap-2">
        <Button asChild variant="outline" size="sm">
          <Link to="/settings/key">Your AI key</Link>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void authClient.signOut().then(() => navigate({ to: "/sign-in" }));
          }}
        >
          Sign out
        </Button>
      </div>
    </CentredPage>
  );
}
