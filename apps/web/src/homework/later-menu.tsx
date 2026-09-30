import { snoozeUntil, type Snooze } from "@grounded/core/snooze";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useFormat, useT } from "@/i18n";
import { browserTimeZone, choicesNow, useNow } from "@/lib/snooze";

/**
 * "Later" (design §7.4): homework is put off until a time, never skipped, so the button asks when:
 * tonight (while it is still ahead) or tomorrow, each with its time on the learner's clock.
 */
export function LaterMenu(props: {
  disabled?: boolean;
  onChoose: (snooze: Snooze) => void;
  size?: "sm" | "default";
}) {
  const now = useNow();
  const { homework: t, common } = useT();
  const format = useFormat();
  // "20:00", or "8 PM": when a snooze ends, on the learner's clock, in the app's language.
  const clock = (instant: Date) => format.date(instant, { hour: "numeric", minute: "2-digit" });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={props.disabled}>
        <Button type="button" variant="ghost" size={props.size ?? "default"}>
          {t.later}
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuLabel className="text-[12px] font-normal text-subtle-foreground">
          {t.remindMe}
        </DropdownMenuLabel>
        {choicesNow(now).map((snooze) => {
          const until = snoozeUntil(snooze, now, browserTimeZone());
          return (
            <DropdownMenuItem
              key={snooze}
              onSelect={() => {
                props.onChoose(snooze);
              }}
            >
              {common.snooze[snooze]}
              {until && (
                <span className="ml-auto text-[12px] text-subtle-foreground">{clock(until)}</span>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
