import type { Block } from "@grounded/content";
import { BookmarkCheck, BookmarkPlus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Composer } from "@/components/composer";
import { LearnerText } from "@/content/learner-text";
import { StreamedText, useRevealedText } from "@/components/streamed-text";
import { WorkingMark } from "@/components/working-mark";
import { Button } from "@/components/ui/button";
import { Blocks } from "@/content/blocks";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Aside } from "./types";

/** The passage a card is about, quoted (in the sheet, and for a card whose passage is gone). */
export function QuotedPassage({ quote, className }: { quote: string; className?: string }) {
  return (
    <blockquote
      className={cn(
        "line-clamp-3 border-l-2 border-primary/60 pl-2.5 font-serif text-[14px] leading-snug text-muted-foreground italic",
        className,
      )}
    >
      {quote}
    </blockquote>
  );
}

/** "Thinking…" until the answer's first words arrive. */
export function Thinking() {
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-subtle-foreground">
      <WorkingMark />
      <span className="text-shimmer mb-px">Thinking…</span>
    </div>
  );
}

/** An answer: revealed as it streams, then its blocks once all of it is shown. */
function Answer({
  text,
  blocks,
  streaming,
}: {
  text: string;
  blocks: Block[] | null;
  streaming: boolean;
}) {
  const revealed = useRevealedText(text, streaming);
  if (streaming && !text) return <Thinking />;
  // The blocks wait for the reveal to finish, so the text doesn't jump ahead as it turns into them.
  const shown = revealed.done ? blocks : null;
  return (
    <div className="font-serif text-[15.5px] leading-[1.55] [&_p]:mb-2 [&_p:last-child]:mb-0 [&_pre]:text-[12.5px]">
      {shown ? <Blocks blocks={shown} /> : <StreamedText revealed={revealed} />}
    </div>
  );
}

interface Exchange {
  /** The learner's question's id, which keys its answer while it streams and after. */
  id: string;
  question: string;
  answer: { text: string; blocks: Block[] | null; streaming: boolean } | null;
}

/** The thread as questions, each with its answer (streaming, for the last one still waiting). */
function exchangesOf(aside: Aside): Exchange[] {
  const exchanges: Exchange[] = [];
  for (const message of aside.messages) {
    if (message.role === "learner") {
      exchanges.push({ id: message.id, question: message.text ?? "", answer: null });
      continue;
    }
    const last = exchanges.at(-1);
    if (last && !last.answer)
      last.answer = { text: message.text ?? "", blocks: message.blocks, streaming: false };
  }
  const last = exchanges.at(-1);
  if (last && !last.answer)
    last.answer = { text: aside.draft ?? "", blocks: null, streaming: true };
  return exchanges;
}

export interface AsideThreadProps {
  aside: Aside;
  /** The whole thread and a follow-up box; otherwise the first question and the latest answer. */
  expanded: boolean;
  canAsk: boolean;
  onFollowUp: (text: string) => Promise<void>;
  onSave: () => void;
  onClose?: () => void;
}

/** An aside's questions and answers, a tangent to save, and a box for a follow-up. */
export function AsideThread({
  aside,
  expanded,
  canAsk,
  onFollowUp,
  onSave,
  onClose,
}: AsideThreadProps) {
  const exchanges = exchangesOf(aside);
  const waiting = exchanges.at(-1)?.answer?.streaming === true;
  const shown = expanded ? exchanges : exchanges.slice(0, 1);
  const more = exchanges.length - shown.length;

  return (
    <div className="flex flex-col">
      {shown.map((exchange, i) => (
        <div key={exchange.id} className={cn(i > 0 && "mt-3 border-t pt-3")}>
          <p className="mb-1.5 text-[13px] leading-snug font-medium whitespace-pre-wrap text-foreground">
            <LearnerText text={exchange.question} />
          </p>
          {exchange.answer && (
            <div
              className={cn(
                !expanded &&
                  "max-h-[7.4em] overflow-hidden [mask-image:linear-gradient(to_bottom,black_55%,transparent)]",
              )}
            >
              <Answer key={exchange.id} {...exchange.answer} />
            </div>
          )}
        </div>
      ))}
      {more > 0 && (
        <p className="mt-2 text-[11.5px] text-subtle-foreground">
          {more} more {more === 1 ? "question" : "questions"}
        </p>
      )}
      {expanded && aside.tangent && (
        <Tangent tangent={aside.tangent} saved={aside.saved} canSave={canAsk} onSave={onSave} />
      )}
      {expanded && canAsk && (
        <FollowUp waiting={waiting} onSubmit={onFollowUp} onCancel={onClose} />
      )}
    </div>
  );
}

function Tangent(props: { tangent: string; saved: boolean; canSave: boolean; onSave: () => void }) {
  const Icon = props.saved ? BookmarkCheck : BookmarkPlus;
  return (
    <div className="mt-3 flex gap-2 rounded-md bg-highlight px-2.5 py-2 text-[12.5px] leading-snug">
      <Icon className="mt-px size-3.5 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0">
        <p className="text-muted-foreground">{props.tangent}</p>
        {props.saved ? (
          <p className="mt-0.5 text-primary">Saved for a future session</p>
        ) : (
          props.canSave && (
            <button
              type="button"
              onClick={props.onSave}
              className="mt-0.5 font-medium text-primary underline-offset-2 hover:underline"
            >
              Save for a future session
            </button>
          )
        )}
      </div>
    </div>
  );
}

/** The box for a question: the first one on a passage, or a follow-up in the card. */
export function QuestionBox({
  label,
  placeholder,
  submitLabel,
  waiting = false,
  onSubmit,
  onCancel,
  minRows = 1,
  autoFocus = false,
  children,
}: {
  label: string;
  placeholder: string;
  submitLabel: string;
  waiting?: boolean;
  onSubmit: (text: string) => Promise<unknown>;
  onCancel?: (() => void) | undefined;
  minRows?: number;
  autoFocus?: boolean;
  children?: ReactNode;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (text: string) => {
    setSending(true);
    setError(null);
    onSubmit(text)
      .then(() => {
        setDraft("");
      })
      .catch((failure: unknown) => {
        setError(
          failure instanceof ApiError ? failure.message : "That didn't go through. Try again.",
        );
      })
      .finally(() => {
        setSending(false);
      });
  };
  return (
    <div
      className="mt-3"
      onKeyDown={(event) => {
        if (event.key === "Escape" && onCancel) {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <Composer
        label={label}
        submitLabel={submitLabel}
        submitIcon
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        submitDisabled={waiting || sending}
        placeholder={placeholder}
        minRows={minRows}
        autoFocus={autoFocus}
        rich
        className="rounded-lg bg-background [&_.line-field]:px-3 [&_.line-field]:pt-2 [&_.line-prose]:text-[14px]"
        actions={children}
      />
      {error && <p className="mt-1.5 text-[12px] text-destructive">{error}</p>}
    </div>
  );
}

function FollowUp(props: {
  waiting: boolean;
  onSubmit: (text: string) => Promise<void>;
  onCancel?: (() => void) | undefined;
}) {
  return (
    <QuestionBox
      label="Follow up"
      placeholder={props.waiting ? "Answering…" : "Ask a follow-up…"}
      submitLabel="Send"
      waiting={props.waiting}
      onSubmit={props.onSubmit}
      onCancel={props.onCancel}
    />
  );
}

/** The first question on a passage, before its card exists. */
export function AskDraft(props: {
  onSubmit: (text: string) => Promise<unknown>;
  onCancel: () => void;
  quote?: string;
}) {
  return (
    <div>
      {props.quote && <QuotedPassage quote={props.quote} className="mb-2" />}
      <QuestionBox
        label="Your question about this passage"
        placeholder="Ask about this passage…"
        submitLabel="Ask"
        minRows={2}
        autoFocus
        onSubmit={props.onSubmit}
        onCancel={props.onCancel}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mr-auto h-7 px-2 text-[12.5px] text-muted-foreground"
          onClick={props.onCancel}
        >
          Cancel
        </Button>
      </QuestionBox>
    </div>
  );
}
