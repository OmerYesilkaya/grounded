import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChartNoAxesColumn,
  ChevronsUpDown,
  KeyRound,
  LockKeyhole,
  LogOut,
  NotebookPen,
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
import { LANGUAGE_NAMES, LANGUAGES, setLanguage, useLanguage, useT, type Language } from "@/i18n";
import { signOut } from "@/lib/auth";
import { setThemeChoice, useThemeChoice, type ThemeChoice } from "@/lib/theme";
import { cn } from "@/lib/utils";

const THEMES: { value: ThemeChoice; icon: LucideIcon }[] = [
  { value: "dark", icon: Moon },
  { value: "light", icon: Sun },
  { value: "system", icon: Monitor },
];

const CHOICE =
  "size-6 justify-center rounded-[3px] p-0 text-subtle-foreground pointer-coarse:size-9 pointer-coarse:p-0 focus:text-foreground data-[state=checked]:bg-highlight data-[state=checked]:text-primary";

/**
 * The account row at the foot of the sidebar (design §9.2); its actions sit in a menu, with the
 * theme and the language (design §9.3).
 */
export function AccountMenu({ email }: { email: string }) {
  const navigate = useNavigate();
  const theme = useThemeChoice();
  const language = useLanguage();
  const t = useT().account.menu;
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
          <Link to="/teaching-notes">
            <NotebookPen />
            {t.howYouLearn}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/settings/key">
            <KeyRound />
            {t.apiKey}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/settings/password">
            <LockKeyhole />
            {t.password}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/usage">
            <ChartNoAxesColumn />
            {t.usage}
          </Link>
        </DropdownMenuItem>
        {/* The theme (design §9.3) as three icons in a row. Choosing one leaves the menu open, so
            the change is seen in place. */}
        <div className="flex items-center justify-between py-0.5 pr-1 pl-2">
          <span id="theme-label" className="text-[13px]">
            {t.theme}
          </span>
          <DropdownMenuRadioGroup
            aria-labelledby="theme-label"
            value={theme}
            onValueChange={(value) => {
              setThemeChoice(value as ThemeChoice);
            }}
            className="flex gap-px rounded-[4px] border p-px"
          >
            {THEMES.map(({ value, icon: Icon }) => (
              <DropdownMenuRadioItem
                key={value}
                value={value}
                aria-label={t.themes[value]}
                title={t.themes[value]}
                onSelect={(event) => {
                  event.preventDefault();
                }}
                className={CHOICE}
              >
                <Icon className="size-3.5" />
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </div>
        {/* The app's language (design §9.3), the same way: each in its own words, the menu staying
            open so the change is seen. */}
        <div className="flex items-center justify-between py-0.5 pr-1 pl-2">
          <span id="language-label" className="text-[13px]">
            {t.language}
          </span>
          <DropdownMenuRadioGroup
            aria-labelledby="language-label"
            value={language}
            onValueChange={(value) => {
              setLanguage(value as Language);
            }}
            className="flex gap-px rounded-[4px] border p-px"
          >
            {LANGUAGES.map((value) => (
              <DropdownMenuRadioItem
                key={value}
                value={value}
                lang={value}
                aria-label={LANGUAGE_NAMES[value]}
                title={LANGUAGE_NAMES[value]}
                onSelect={(event) => {
                  event.preventDefault();
                }}
                className={cn(CHOICE, "w-8 text-[11px] font-medium uppercase pointer-coarse:w-11")}
              >
                {value}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            void signOut().then(() => navigate({ to: "/sign-in" }));
          }}
        >
          <LogOut />
          {t.signOut}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
