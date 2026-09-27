import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Composer } from "@/components/composer";
import { ActivityLine } from "@/components/activity-line";
import { Button } from "@/components/ui/button";
import { Blocks } from "@/content/blocks";
import { api } from "@/lib/api";
import type { ChatMessage, SessionModel } from "@/lib/session";
import { cn } from "@/lib/utils";

const KIND_LABEL: Partial<Record<ChatMessage["kind"], string>> = {
  plan: "The plan",
  homework: "Homework",
  recap: "Recap",
};

function Message({ message }: { message: ChatMessage }) {
  if (message.role === "learner") {
    return (
      <div className="max-w-[85%] self-end rounded-xl bg-muted px-3.5 py-2 text-[15px] leading-relaxed whitespace-pre-wrap">
        {message.text}
      </div>
    );
  }
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
        {message.streaming || !message.blocks ? (
          <p className="whitespace-pre-wrap">{message.text}</p>
        ) : (
          <Blocks blocks={message.blocks} />
        )}
      </div>
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
  const endRef = useRef<HTMLDivElement>(null);
  const { phase, plan } = model.state;
  const writing = model.messages.some((m) => m.streaming);
  const hasSteps = (model.lesson?.steps.length ?? 0) > 0;
  const waiting = !writing && model.messages.at(-1)?.role === "learner";

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

  const barRef = useRef<HTMLDivElement>(null);
  const barHeight = useBarHeight(barRef, phase === "probe" || phase === "plan");

  const lastLength = model.messages.at(-1)?.text?.length ?? 0;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [model.messages.length, lastLength]);

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
      className="mx-auto flex w-full max-w-[68ch] flex-1 flex-col px-6 pt-9"
      style={{ paddingBottom: `${String(barHeight + 40)}px` }}
    >
      <div className="flex flex-col gap-5">
        {model.messages.map((m) => (
          <Message key={m.id} message={m} />
        ))}
        <ActivityLine
          activities={model.activities}
          fallback={
            waiting || (phase === "plan" && plan !== "proposed" && !writing)
              ? "Thinking…"
              : undefined
          }
        />
        {phase === "lesson" && (
          <div className="rounded-xl border bg-card px-5 py-4 text-sm">
            {hasSteps ? (
              <>
                The lesson is on.{" "}
                <Button variant="link" className="h-auto px-0" onClick={onOpenLesson}>
                  Open the lesson
                </Button>
              </>
            ) : (
              "The lesson is being written; it opens as soon as the first step is ready."
            )}
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
        {model.error && <p className="text-sm text-destructive">{model.error}</p>}
        <div ref={endRef} />
      </div>

      {phase === "plan" && plan === "proposed" && !writing && (
        <div className="mt-6 flex items-center gap-3">
          <Button
            disabled={approve.isPending}
            onClick={() => {
              approve.mutate();
            }}
          >
            Approve the plan
          </Button>
          <span className="text-sm text-subtle-foreground">or reply below to change it</span>
        </div>
      )}

      {(phase === "probe" || phase === "plan") && (
        <div
          ref={barRef}
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
 * The composer bar's height, kept current: the bar is fixed over the page and grows with its text,
 * so the conversation leaves that much room below its last message.
 */
function useBarHeight(ref: RefObject<HTMLElement | null>, present: boolean): number {
  const [height, setHeight] = useState(0);
  const pinToBottom = useRef(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!present || !element || typeof ResizeObserver === "undefined") return;
    let last = 0;
    // Called once on observe, then on every change.
    const observer = new ResizeObserver(() => {
      const next = element.offsetHeight;
      if (next === last) return;
      const root = document.documentElement;
      pinToBottom.current =
        next > last && window.innerHeight + window.scrollY >= root.scrollHeight - 8;
      last = next;
      setHeight(next);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [ref, present]);

  // A reader at the bottom stays there as the bar grows, so their last message isn't covered.
  useLayoutEffect(() => {
    if (!pinToBottom.current) return;
    pinToBottom.current = false;
    window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [height]);

  return present ? height : 0;
}
