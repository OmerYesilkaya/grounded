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
import { browserTimeZone, choicesNow, SNOOZE_WORDS, useNow } from "@/lib/snooze";

/** "20:00", or "8 PM": when a snooze ends, on the learner's clock. */
const clock = (instant: Date) =>
  instant.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={props.disabled}>
        <Button type="button" variant="ghost" size={props.size ?? "default"}>
          Later
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuLabel className="text-[12px] font-normal text-subtle-foreground">
          Remind me
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
              {SNOOZE_WORDS[snooze]}
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
