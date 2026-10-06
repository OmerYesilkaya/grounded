import type { CheckBlock } from "@grounded/content";
import type { CheckOutcome } from "@grounded/core/check";
import { useState } from "react";
import { Composer } from "@/components/composer";
import { LearnerText } from "@/content/learner-text";
import { WorkingMark } from "@/components/working-mark";
import { Button } from "@/components/ui/button";
import { Blocks } from "@/content/blocks";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import type { StepProgress } from "./types";
import { saidBlocks } from "@/i18n/notice";

export interface CheckCardProps {
  check: CheckBlock;
  progress: StepProgress;
  onAnswer: (text: string) => void;
  onDontKnow: () => void;
  onPause: () => void;
  onContinue: () => void;
}

/** How each verdict's label reads: unproven is neither a pass nor a miss (design §7.3). */
const VERDICT_TONE: Record<CheckOutcome, string> = {
  landed: "text-success",
  unproven: "text-muted-foreground",
  missed: "text-destructive",
};

/** A button of the card, stacked full width below the small breakpoint: a finger tall, and wrapping. */
const STACKED =
  "max-sm:h-auto max-sm:min-h-11 max-sm:py-2 max-sm:text-[15px] max-sm:whitespace-normal";

export function CheckCard({
  check,
  progress,
  onAnswer,
  onDontKnow,
  onPause,
  onContinue,
}: CheckCardProps) {
  const [draft, setDraft] = useState("");
  const all = useT();
  const t = all.lesson.check;
  const done = progress.status === "passed" || progress.status === "settling";
  const answering = progress.status === "open" && !progress.offerGate;

  const submit = (text: string) => {
    onAnswer(text);
    setDraft("");
  };

  return (
    <div
      role="group"
      aria-label={t.label}
      className="my-7 overflow-hidden rounded-xl border border-border-strong bg-card font-sans [--mark-surface:var(--card)]"
    >
      <div className="px-4.5 pt-4 pb-3">
        <span className="mb-1.5 block text-[11.5px] tracking-widest text-primary uppercase">
          {done ? t.done : t.label}
        </span>
        <div className="font-serif text-lg leading-normal [&_p]:mb-0">
          <Blocks blocks={check.children} />
        </div>
      </div>

      {progress.thread.length > 0 && (
        <div className="flex flex-col gap-3 border-t px-4.5 py-3">
          {progress.thread.map((message, i) =>
            message.from === "learner" ? (
              <div key={i} className="text-[14.5px]">
                <div className="text-[11.5px] tracking-wide text-subtle-foreground uppercase">
                  {t.you}
                </div>
                <div className="whitespace-pre-wrap text-muted-foreground">
                  <LearnerText text={message.text} />
                </div>
              </div>
            ) : (
              // A landed verdict is where the page's glide to the step it opens stops (steps.ts).
              <div key={i} data-verdict={message.verdict} className="scroll-mt-20">
                <div className="text-[11.5px] tracking-wide text-subtle-foreground uppercase">
                  {t.tutor}
                </div>
                {message.verdict && (
                  <div className={cn("text-[12.5px] font-semibold", VERDICT_TONE[message.verdict])}>
                    {t[message.verdict]}
                  </div>
                )}
                <div className="font-serif text-[16.5px] [&_p]:mb-2 [&_p:last-child]:mb-0">
                  <Blocks
                    blocks={message.failure ? saidBlocks(message.failure, all) : message.blocks}
                  />
                </div>
              </div>
            ),
          )}
          {progress.grading && (
            <div className="flex items-center gap-2 text-[13px] text-subtle-foreground">
              <WorkingMark />
              <span className="text-shimmer mb-px">{t.checking}</span>
            </div>
          )}
        </div>
      )}

      {progress.status === "open" && progress.offerGate && (
        // Below the small breakpoint the choices stack, full width and a finger tall (design §9.4).
        <div className="flex flex-wrap gap-2 border-t px-4.5 py-3 max-sm:flex-col">
          <p className="w-full text-[12.5px] text-subtle-foreground">{t.settling}</p>
          <Button variant="outline" size="sm" onClick={onPause} className={STACKED}>
            {t.pause}
          </Button>
          <Button variant="outline" size="sm" onClick={onContinue} className={STACKED}>
            {t.continue}
          </Button>
        </div>
      )}

      {progress.status === "paused" && (
        <p className="border-t px-4.5 py-3 text-[13.5px] text-muted-foreground">{t.paused}</p>
      )}

      {answering && (
        <div className="px-3 pb-3">
          <Composer
            label={t.yourAnswer}
            submitLabel={t.answer}
            value={draft}
            onChange={setDraft}
            onSubmit={submit}
            disabled={progress.grading === true}
            placeholder={progress.thread.length ? t.answerNew : t.firstAnswer}
            stackActions
            rich
            autoFocus
            focusKey={progress.thread.length}
            className="bg-background"
            actions={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={progress.grading}
                onClick={onDontKnow}
                className={cn(STACKED, "text-muted-foreground max-sm:border max-sm:border-input")}
              >
                {t.dontKnow}
              </Button>
            }
          />
        </div>
      )}
    </div>
  );
}
