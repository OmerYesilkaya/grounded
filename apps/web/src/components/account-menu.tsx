import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChartNoAxesColumn,
  ChevronsUpDown,
  KeyRound,
  LogOut,
  Monitor,
  Moon,
  Sun,
  type LucideIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";
import { setThemeChoice, useThemeChoice, type ThemeChoice } from "@/lib/theme";

const THEMES: { value: ThemeChoice; label: string; icon: LucideIcon }[] = [
  { value: "dark", label: "Dark", icon: Moon },
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "Follow system", icon: Monitor },
];

/** The account row at the foot of the sidebar (design §9.2); its actions sit in a menu. */
export function AccountMenu({ email }: { email: string }) {
  const navigate = useNavigate();
  const theme = useThemeChoice();
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
        <DropdownMenuItem asChild>
          <Link to="/usage">
            <ChartNoAxesColumn />
            Usage
          </Link>
        </DropdownMenuItem>
        {/* The theme (design §9.3) as three icons in a row. Choosing one leaves the menu open, so
            the change is seen in place. */}
        <div className="flex items-center justify-between py-0.5 pr-1 pl-2">
          <span id="theme-label" className="text-[13px]">
            Theme
          </span>
          <DropdownMenuRadioGroup
            aria-labelledby="theme-label"
            value={theme}
            onValueChange={(value) => {
              setThemeChoice(value as ThemeChoice);
            }}
            className="flex gap-px rounded-[4px] border p-px"
          >
            {THEMES.map(({ value, label, icon: Icon }) => (
              <DropdownMenuRadioItem
                key={value}
                value={value}
                aria-label={label}
                title={label}
                onSelect={(event) => {
                  event.preventDefault();
                }}
                className="size-6 justify-center rounded-[3px] p-0 text-subtle-foreground focus:text-foreground data-[state=checked]:bg-highlight data-[state=checked]:text-primary"
              >
                <Icon className="size-3.5" />
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </div>
        <DropdownMenuSeparator />
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
