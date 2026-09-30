import { awaitedJob } from "@grounded/core/session";
import { useMutation } from "@tanstack/react-query";
import { ArrowDown } from "lucide-react";
import { Fragment, useLayoutEffect, useState, type ReactNode } from "react";
import { Composer } from "@/components/composer";
import { ActivityLine } from "@/components/activity-line";
import { HomeworkFooter } from "@/components/homework-footer";
import { FinalIntro } from "@/components/final-chat";
import { FinalOutcomeCard } from "@/components/final-outcome";
import { NextSession } from "@/components/next-session";
import { ChatRule, ReviewDone, ReviewHeading } from "@/components/opening-review";
import { VerdictSeam } from "@/components/probe-verdict";
import { PlanPicture } from "@/components/session-pictures";
import { StreamedText, useRevealedText } from "@/components/streamed-text";
import { Button } from "@/components/ui/button";
import { Blocks } from "@/content/blocks";
import { api } from "@/lib/api";
import type { ChatMessage, SessionModel } from "@/lib/session";
import { useTracks } from "@/lib/tracks";
import { useStickToBottom } from "@/lib/stick-to-bottom";
import { cn } from "@/lib/utils";
import { useVisibleViewport } from "@/lib/visible-viewport";
import { LessonAgain } from "./lesson-again";

const KIND_LABEL: Partial<Record<ChatMessage["kind"], string>> = {
  plan: "The plan",
  homework: "Homework",
  exam: "Arc exam",
  recap: "Recap",
};

/** `footer` ends a tutor message's card (the plan's picture). */
function Message({ message, footer }: { message: ChatMessage; footer?: ReactNode }) {
  if (message.role === "learner") {
    return (
      <div className="max-w-[85%] self-end rounded-xl bg-muted px-3.5 py-2 text-[15px] leading-relaxed whitespace-pre-wrap">
        {message.text}
      </div>
    );
  }
  return <TutorMessage message={message} footer={footer} />;
}

function TutorMessage({ message, footer }: { message: ChatMessage; footer?: ReactNode }) {
  const revealed = useRevealedText(message.text ?? "", message.streaming === true);
  // The blocks wait for the reveal to finish, so the text doesn't jump ahead as it turns into them.
  const blocks = revealed.done ? message.blocks : null;

  const label = KIND_LABEL[message.kind];
  return (
    <div
      className={cn(
        "max-w-[92%]",
        label && "w-full max-w-none rounded-xl border bg-card px-5 py-4",
      )}
    >
      {label && (
        <div className="mb-2 text-[11px] tracking-widest text-primary uppercase">{label}</div>
      )}
      <div className="font-serif text-[17px] leading-[1.6] [&_p:last-child]:mb-0">
        {blocks ? <Blocks blocks={blocks} /> : <StreamedText revealed={revealed} />}
      </div>
      {blocks && footer}
    </div>
  );
}

/** Where each of the final's parts begins in its chat (design §7.4). */
const PART_RULE: Partial<Record<ChatMessage["kind"], string>> = {
  audit: "The fresh audit",
  "teach-back": "The teach-back",
};

/** The composer's hint in each phase the learner answers in. */
const PLACEHOLDER: Partial<Record<SessionModel["state"]["phase"], string>> = {
  review: "Answer in your own words; “I don't know” is fine.",
  probe: "Answer in your own words; “I don't know” is fine.",
  audit: "Answer in your own words; “I don't know” is fine.",
  "teach-back": "In your own words; “I don't know why” is fine too.",
  plan: "Reply to change the plan…",
};

/** The session chat: probe, plan, homework and recap; the final's parts (design §7.1, §7.4). */
export function ChatView({
  model,
  onOpenLesson,
}: {
  model: SessionModel;
  onOpenLesson: () => void;
}) {
  const [draft, setDraft] = useState("");
  const { phase, plan } = model.state;
  const writing = model.messages.some((m) => m.streaming);
  const hasSteps = (model.lesson?.steps.length ?? 0) > 0;
  // A failed lesson says so here too, with its way back: the lesson's tab may have nothing to show.
  const lessonFailed = phase === "lesson" && model.state.lesson.status === "failed";
  const waiting = !writing && model.messages.at(-1)?.role === "learner";
  // The job the session waits on failed, or died, and writing can't set it going again (design
  // §4.2): say so, and offer to try it again.
  const stuck =
    awaitedJob(model.state, model.messages.at(-1)?.role ?? null) !== null &&
    (model.error !== null || model.stalled) &&
    !writing &&
    model.activities.length === 0;
  const retry = useMutation({
    mutationFn: () => api(`/api/sessions/${model.id}/retry`, { method: "POST" }),
  });

  const send = useMutation({
    mutationFn: (text: string) =>
      api(`/api/sessions/${model.id}/messages`, { method: "POST", body: JSON.stringify({ text }) }),
    onSuccess: () => {
      setDraft("");
    },
  });
  const approve = useMutation({
    mutationFn: () => api(`/api/sessions/${model.id}/approve-plan`, { method: "POST" }),
  });
  const track = useTracks().data?.find((t) => t.id === model.trackId);
  const final = model.state.kind === "final";

  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const [bar, setBar] = useState<HTMLDivElement | null>(null);
  const barHeight = useHeight(bar);
  // The box stays above the on-screen keyboard (design §9.4).
  const { keyboard } = useVisibleViewport();
  const stick = useStickToBottom({ content, overlay: bar });

  // The opening review and the final's parts are answered in the chat like the probe (design
  // §7.1, §7.4).
  const talking =
    phase === "review" || phase === "probe" || phase === "audit" || phase === "teach-back";
  const canWrite = (talking || (phase === "plan" && plan === "proposed")) && !writing && !waiting;
  const placeholder = PLACEHOLDER[phase] ?? "";
  // The seam between the probe and the plan: before the first plan, or after the probe while the
  // plan is still to come.
  const firstPlan = model.messages.findIndex((m) => m.kind === "plan");

  return (
    <div
      ref={setContent}
      className="mx-auto flex w-full max-w-[68ch] flex-1 flex-col px-6 pt-9"
      style={{ paddingBottom: `${String(barHeight + 40)}px` }}
    >
      <div className="flex flex-col gap-5">
        {final && <FinalIntro />}
        {/* The review's first message may wait for the review of work just handed in. */}
        {phase === "review" && model.messages.length === 0 && (
          <ReviewHeading takenUp={model.takenUp} />
        )}
        {model.messages.map((m, i) => {
          const before = model.messages[i - 1];
          return (
            <Fragment key={m.id}>
              {/* Where the first probe ends and the plan begins (design §7.1). */}
              {i === firstPlan && <VerdictSeam model={model} />}
              {m.kind === "review" && before?.kind !== "review" && (
                <ReviewHeading takenUp={model.takenUp} />
              )}
              {before?.kind === "review" && m.kind !== "review" && !final && <ReviewDone />}
              {PART_RULE[m.kind] && before?.kind !== m.kind && (
                <ChatRule label={PART_RULE[m.kind] ?? ""} />
              )}
              <Message
                message={m}
                footer={
                  m.kind === "plan" ? (
                    <PlanPicture model={model} messageId={m.id} />
                  ) : m.kind === "homework" || m.kind === "exam" ? (
                    <HomeworkFooter model={model} messageId={m.id} />
                  ) : null
                }
              />
            </Fragment>
          );
        })}
        {firstPlan === -1 && <VerdictSeam model={model} />}
        <ActivityLine
          activities={model.activities}
          fallback={
            stuck
              ? undefined
              : phase === "review" && model.messages.length === 0
                ? "Looking over what came up since last time…"
                : waiting || (phase === "plan" && plan !== "proposed" && !writing)
                  ? "Thinking…"
                  : undefined
          }
        />
        {/* While the first step is written, the activity line above says so; the card is the way in. */}
        {lessonFailed && <LessonAgain model={model} />}
        {phase === "lesson" && hasSteps && !lessonFailed && (
          <div className="rounded-xl border bg-card px-5 py-4 text-sm">
            The lesson is on.{" "}
            <Button
              variant="link"
              className="h-auto px-0 pointer-coarse:h-auto"
              onClick={onOpenLesson}
            >
              Open the lesson
            </Button>
          </div>
        )}
        {/* The end of the track: what its final found (design §7.4). */}
        {phase === "closed" && final && (
          <FinalOutcomeCard
            sessionId={model.id}
            footer={
              track &&
              !track.openSession && (
                <NextSession track={track} lead="A next session takes up what the final found." />
              )
            }
          />
        )}
        {phase === "closed" && !final && track && !track.openSession && (
          <div className="border-t pt-5">
            <NextSession
              track={track}
              lead="This session is done."
              label="Start the next session"
            />
          </div>
        )}
        {stuck ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-destructive">
              {model.error ?? "The tutor stopped before finishing."}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={retry.isPending}
              onClick={() => {
                retry.mutate();
              }}
            >
              Try again
            </Button>
            {retry.error && <p className="text-sm text-destructive">{retry.error.message}</p>}
          </div>
        ) : (
          model.error && !lessonFailed && <p className="text-sm text-destructive">{model.error}</p>
        )}
      </div>

      {phase === "plan" && plan === "proposed" && !writing && (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button
            disabled={approve.isPending}
            onClick={() => {
              stick.scrollToBottom();
              approve.mutate();
            }}
          >
            Approve the plan
          </Button>
          <span className="text-sm text-subtle-foreground">or reply below to change it</span>
        </div>
      )}

      {!stick.following && (
        <div
          className="pointer-events-none fixed right-0 left-0 flex justify-center md:left-[248px]"
          style={{ bottom: `${String(barHeight + keyboard + 12)}px` }}
        >
          <Button
            variant="outline"
            size="sm"
            className="pointer-events-auto rounded-full bg-card shadow-sm dark:bg-card"
            onClick={() => {
              stick.scrollToBottom({ smooth: true });
            }}
          >
            <ArrowDown aria-hidden />
            Jump to latest
          </Button>
        </div>
      )}

      {(talking || phase === "plan") && (
        <div
          ref={setBar}
          style={{ bottom: keyboard }}
          className="fixed right-0 left-0 bg-background/90 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur md:left-[248px]"
        >
          <div className="mx-auto max-w-[68ch] px-6">
            <Composer
              label="Message"
              submitLabel="Send"
              submitIcon
              value={draft}
              onChange={setDraft}
              onSubmit={(text) => {
                stick.scrollToBottom();
                send.mutate(text);
              }}
              disabled={!canWrite}
              submitDisabled={send.isPending}
              placeholder={placeholder}
              autoFocus
            />
            {(send.error ?? approve.error) && (
              <p className="mt-2 text-sm text-destructive">
                {(send.error ?? approve.error)?.message}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * An element's height, kept current: the composer bar is fixed over the page and grows with its
 * text, so the conversation leaves that much room below its last message.
 */
function useHeight(element: HTMLElement | null): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setHeight(element.offsetHeight);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [element]);
  return element ? height : 0;
}
