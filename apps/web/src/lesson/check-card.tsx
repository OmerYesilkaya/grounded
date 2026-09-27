import type { CheckBlock } from "@grounded/content";
import { useState } from "react";
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

  const submit = () => {
    const text = draft.trim();
    if (!text || progress.grading) return;
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
        <form
          className="flex flex-wrap gap-2 px-3 pb-3 max-sm:flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            aria-label="Your answer"
            value={draft}
            disabled={progress.grading}
            placeholder={progress.thread.length ? "Answer the new question…" : "One or two lines…"}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            className="min-w-0 flex-1 rounded-lg border border-input bg-background px-3 py-2.5 text-foreground outline-none focus:border-ring disabled:opacity-60 max-sm:w-full"
          />
          <Button
            type="button"
            variant="outline"
            disabled={progress.grading}
            onClick={onDontKnow}
            className="h-auto"
          >
            I don&apos;t know
          </Button>
          <Button type="submit" disabled={!draft.trim() || progress.grading} className="h-auto">
            Answer
          </Button>
        </form>
      )}
    </div>
  );
}
