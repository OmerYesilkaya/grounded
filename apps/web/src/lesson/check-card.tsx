import type { CheckBlock } from "@grounded/content";
import { useState } from "react";
import { Composer } from "@/components/composer";
import { Button } from "@/components/ui/button";
import { Blocks } from "@/content/blocks";
import { cn } from "@/lib/utils";
import type { StepProgress } from "./types";

export interface CheckCardProps {
  check: CheckBlock;
  progress: StepProgress;
  onAnswer: (text: string) => void;
  onDontKnow: () => void;
  onPause: () => void;
  onContinue: () => void;
}

export function CheckCard({
  check,
  progress,
  onAnswer,
  onDontKnow,
  onPause,
  onContinue,
}: CheckCardProps) {
  const [draft, setDraft] = useState("");
  const done = progress.status === "passed" || progress.status === "settling";
  const answering = progress.status === "open" && !progress.offerGate;

  const submit = (text: string) => {
    onAnswer(text);
    setDraft("");
  };

  return (
    <div
      role="group"
      aria-label="Check"
      className="my-7 overflow-hidden rounded-xl border border-border-strong bg-card font-sans"
    >
      <div className="px-4.5 pt-4 pb-3">
        <span className="mb-1.5 block text-[11.5px] tracking-widest text-primary uppercase">
          {done ? "Check · done" : "Check"}
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
                  You
                </div>
                <div className="text-muted-foreground">{message.text}</div>
              </div>
            ) : (
              <div key={i}>
                <div className="text-[11.5px] tracking-wide text-subtle-foreground uppercase">
                  Tutor
                </div>
                {message.verdict && (
                  <div
                    className={cn(
                      "text-[12.5px] font-semibold",
                      message.verdict === "landed" ? "text-success" : "text-destructive",
                    )}
                  >
                    {message.verdict === "landed" ? "That's it" : "Not quite there yet"}
                  </div>
                )}
                <div className="font-serif text-[16.5px] [&_p]:mb-2 [&_p:last-child]:mb-0">
                  <Blocks blocks={message.blocks} />
                </div>
              </div>
            ),
          )}
          {progress.grading && (
            <div className="text-[13px] text-subtle-foreground">Checking your answer…</div>
          )}
        </div>
      )}

      {progress.status === "open" && progress.offerGate && (
        <div className="flex flex-wrap gap-2 border-t px-4.5 py-3">
          <p className="w-full text-[12.5px] text-subtle-foreground">
            This idea is still settling, and the next step rests on it.
          </p>
          <Button variant="outline" size="sm" onClick={onPause}>
            Pause here — try a fresh question next time
          </Button>
          <Button variant="outline" size="sm" onClick={onContinue}>
            Continue anyway
          </Button>
        </div>
      )}

      {progress.status === "paused" && (
        <p className="border-t px-4.5 py-3 text-[13.5px] text-muted-foreground">
          Paused here. Next time starts with a fresh question on this idea.
        </p>
      )}

      {answering && (
        <div className="px-3 pb-3">
          <Composer
            label="Your answer"
            submitLabel="Answer"
            value={draft}
            onChange={setDraft}
            onSubmit={submit}
            disabled={progress.grading === true}
            placeholder={progress.thread.length ? "Answer the new question…" : "One or two lines…"}
            stackActions
            className="bg-background"
            actions={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={progress.grading}
                onClick={onDontKnow}
                className="text-muted-foreground max-sm:border max-sm:border-input"
              >
                I don&apos;t know
              </Button>
            }
          />
        </div>
      )}
    </div>
  );
}
