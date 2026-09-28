import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronsUpDown, KeyRound, LogOut } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";

/** The account row at the foot of the sidebar (design §9.2); its actions sit in a menu. */
export function AccountMenu({ email }: { email: string }) {
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-accent">
        <span
          aria-hidden
          className="flex size-7 shrink-0 items-center justify-center rounded-md bg-highlight text-[12px] font-semibold text-primary uppercase"
        >
          {email.charAt(0)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground" title={email}>
          {email}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-subtle-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        className="w-(--radix-dropdown-menu-trigger-width)"
      >
        <DropdownMenuLabel className="truncate">{email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings/key">
            <KeyRound />
            API key
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            void authClient.signOut().then(() => navigate({ to: "/sign-in" }));
          }}
        >
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
