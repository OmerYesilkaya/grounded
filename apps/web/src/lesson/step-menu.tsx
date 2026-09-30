import type { LessonStep } from "@grounded/content";
import { ChevronDown, Lock, MessageSquare } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Inlines } from "@/content/inlines";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { jumpToStep, unlockedSteps, useCurrentStep } from "./steps";
import type { Aside, StepProgress } from "./types";

/**
 * The lesson's steps where the gutter has no room for its timeline (design §9.4): "Step 2 of 5" in
 * the page's bar, following the scroll, opening a list of the steps to jump to. Locked steps show as
 * dots (their headings would give the discovery away). Each step says how many questions were asked
 * in its margin, so they can be found without tapping every marked passage.
 */
export function StepMenu(props: {
  steps: readonly LessonStep[];
  totalSteps: number;
  progress: Record<string, StepProgress | undefined>;
  asides: readonly Aside[];
  className?: string;
}) {
  const { steps, totalSteps, progress, asides } = props;
  const t = useT().lesson.steps;
  const shown = unlockedSteps(steps, progress);
  const currentId = useCurrentStep(shown);
  const at = Math.max(
    0,
    shown.findIndex((step) => step.id === currentId),
  );
  const locked = Math.max(0, totalSteps - shown.length);
  const questions = (stepId: string) => asides.filter((aside) => aside.stepId === stepId).length;

  return (
    // Not modal: a modal menu holds the page still, and choosing a step scrolls it.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        className={cn(
          "touch-target relative flex items-center gap-1 rounded-md px-2 py-1 text-[12.5px] whitespace-nowrap text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-accent data-[state=open]:text-foreground",
          props.className,
        )}
      >
        {t.stepOf(
          <span className="text-foreground tabular-nums">{at + 1}</span>,
          <span className="tabular-nums">{Math.max(totalSteps, shown.length)}</span>,
        )}
        <ChevronDown aria-hidden className="size-3.5 text-subtle-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[min(70dvh,480px)] w-[min(320px,calc(100vw-24px))] overflow-y-auto"
      >
        {shown.map((step, index) => {
          const current = index === at;
          const count = questions(step.id);
          return (
            <DropdownMenuItem
              key={step.id}
              aria-current={current ? "step" : undefined}
              onSelect={() => {
                jumpToStep(step.id);
              }}
              className="items-start gap-2.5"
            >
              <span
                className={cn(
                  "mt-px w-4 shrink-0 text-right text-[12px] text-subtle-foreground tabular-nums",
                  current && "text-primary",
                )}
              >
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block leading-snug text-muted-foreground",
                    current && "font-medium text-foreground",
                  )}
                >
                  <Inlines inlines={step.heading} />
                </span>
                {(progress[step.id]?.status === "settling" || count > 0) && (
                  <span className="mt-0.5 flex gap-2 text-[11.5px] text-subtle-foreground">
                    {progress[step.id]?.status === "settling" && (
                      <span className="text-primary">{t.stillSettling}</span>
                    )}
                    {count > 0 && (
                      <span className="flex items-center gap-1">
                        <MessageSquare aria-hidden className="size-3" />
                        {t.questions(count)}
                      </span>
                    )}
                  </span>
                )}
              </span>
            </DropdownMenuItem>
          );
        })}
        {Array.from({ length: locked }, (_, i) => (
          <DropdownMenuItem
            key={`locked-${String(i)}`}
            disabled
            aria-label={t.locked}
            className="gap-2.5 text-subtle-foreground"
          >
            <span className="w-4 shrink-0 text-right text-[12px] tabular-nums">
              {shown.length + i + 1}
            </span>
            <span aria-hidden className="flex-1">
              ·····
            </span>
            <Lock aria-hidden className="size-3 text-subtle-foreground" />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
