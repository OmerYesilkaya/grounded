import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
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
  const skip = useMutation({
    mutationFn: () => api(`/api/sessions/${model.id}/skip-to-plan`, { method: "POST" }),
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
    <div className="mx-auto flex w-full max-w-[68ch] flex-1 flex-col px-6 pt-9 pb-40">
      <div className="flex flex-col gap-5">
        {model.messages.map((m) => (
          <Message key={m.id} message={m} />
        ))}
        {(waiting || (phase === "plan" && plan !== "proposed" && !writing)) && (
          <p className="text-sm text-subtle-foreground">
            {phase === "plan" ? "Putting the plan together…" : "Thinking…"}
          </p>
        )}
        {phase === "lesson" && (
          <div className="rounded-xl border bg-card px-5 py-4 text-sm">
            The lesson is on.{" "}
            <Button variant="link" className="h-auto px-0" onClick={onOpenLesson}>
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
        <form
          className="fixed right-0 bottom-0 left-0 border-t bg-background/90 py-3 backdrop-blur md:left-[248px]"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim()) send.mutate(draft.trim());
          }}
        >
          <div className="mx-auto flex max-w-[68ch] gap-2 px-6">
            <input
              aria-label="Message"
              value={draft}
              disabled={!canWrite}
              placeholder={placeholder}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
              className="min-w-0 flex-1 rounded-lg border border-input bg-card px-3 py-2.5 outline-none focus:border-ring disabled:opacity-60"
            />
            <Button type="submit" disabled={!canWrite || !draft.trim()} className="h-auto">
              Send
            </Button>
            {phase === "probe" && (
              <Button
                type="button"
                variant="ghost"
                className="h-auto"
                disabled={skip.isPending || writing}
                onClick={() => {
                  skip.mutate();
                }}
              >
                Skip to the plan
              </Button>
            )}
          </div>
          {(send.error ?? approve.error ?? skip.error) && (
            <p className="mx-auto mt-2 max-w-[68ch] px-6 text-sm text-destructive">
              {(send.error ?? approve.error ?? skip.error)?.message}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
