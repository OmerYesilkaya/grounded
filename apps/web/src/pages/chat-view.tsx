import { awaitedJob } from "@grounded/core/session";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowDown } from "lucide-react";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { Composer } from "@/components/composer";
import { ActivityLine } from "@/components/activity-line";
import { HomeworkFooter } from "@/components/homework-footer";
import { PlanPicture } from "@/components/session-pictures";
import { StreamedText, useRevealedText } from "@/components/streamed-text";
import { Button } from "@/components/ui/button";
import { Blocks } from "@/content/blocks";
import { api } from "@/lib/api";
import type { ChatMessage, SessionModel } from "@/lib/session";
import { useStickToBottom } from "@/lib/stick-to-bottom";
import { cn } from "@/lib/utils";
import { LessonAgain } from "./lesson-again";

const KIND_LABEL: Partial<Record<ChatMessage["kind"], string>> = {
  plan: "The plan",
  homework: "Homework",
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

/** The session chat: probe, plan, homework and recap (design §7.1). */
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
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const next = useMutation({
    mutationFn: () =>
      api<{ id: string }>(`/api/tracks/${model.trackId}/sessions`, { method: "POST" }),
    onSuccess: async ({ id }) => {
      await queryClient.invalidateQueries({ queryKey: ["tracks"] });
      void navigate({ to: "/sessions/$sessionId", params: { sessionId: id } });
    },
  });

  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const [bar, setBar] = useState<HTMLDivElement | null>(null);
  const barHeight = useHeight(bar);
  const stick = useStickToBottom({ content, overlay: bar });

  const canWrite =
    (phase === "probe" || (phase === "plan" && plan === "proposed")) && !writing && !waiting;
  const placeholder =
    phase === "probe"
      ? "Answer in your own words; “I don't know” is fine."
      : phase === "plan"
        ? "Reply to change the plan…"
        : "";

  return (
    <div
      ref={setContent}
      className="mx-auto flex w-full max-w-[68ch] flex-1 flex-col px-6 pt-9"
      style={{ paddingBottom: `${String(barHeight + 40)}px` }}
    >
      <div className="flex flex-col gap-5">
        {model.messages.map((m) => (
          <Message
            key={m.id}
            message={m}
            footer={
              m.kind === "plan" ? (
                <PlanPicture model={model} messageId={m.id} />
              ) : m.kind === "homework" ? (
                <HomeworkFooter model={model} messageId={m.id} />
              ) : null
            }
          />
        ))}
        <ActivityLine
          activities={model.activities}
          fallback={
            !stuck && (waiting || (phase === "plan" && plan !== "proposed" && !writing))
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
        {phase === "closed" && (
          <div className="flex items-center gap-3 border-t pt-5">
            <span className="text-sm text-muted-foreground">This session is done.</span>
            <Button
              size="sm"
              disabled={next.isPending}
              onClick={() => {
                next.mutate();
              }}
            >
              Start the next session
            </Button>
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
          style={{ bottom: `${String(barHeight + 12)}px` }}
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

      {(phase === "probe" || phase === "plan") && (
        <div
          ref={setBar}
          className="fixed right-0 bottom-0 left-0 bg-background/90 pt-2 pb-4 backdrop-blur md:left-[248px]"
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
