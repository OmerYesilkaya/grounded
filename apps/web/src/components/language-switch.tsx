import { LANGUAGE_NAMES, LANGUAGES, setLanguage, useLanguage, useT } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * The app's language on the pages outside the app's shell (signing in, the first key), which have
 * no sidebar to hold the account menu's switch (design §9.3): each language in its own words.
 */
export function LanguageSwitch({ className }: { className?: string }) {
  const language = useLanguage();
  const t = useT().account.menu;
  return (
    <div
      role="radiogroup"
      aria-label={t.language}
      className={cn("flex justify-center gap-3 text-xs", className)}
    >
      {LANGUAGES.map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          lang={value}
          aria-checked={value === language}
          onClick={() => {
            setLanguage(value);
          }}
          className={cn(
            "rounded-[3px] px-1 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            value === language
              ? "text-foreground"
              : "text-subtle-foreground underline-offset-2 hover:text-foreground hover:underline",
          )}
        >
          {LANGUAGE_NAMES[value]}
        </button>
      ))}
    </div>
  );
}
