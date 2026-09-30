import type { Block } from "@grounded/content";
import type { ChecklistItem } from "@grounded/core/assignment";
import { Check, Droplet } from "lucide-react";
import { LearnerText } from "@/content/learner-text";
import { useT, type Messages } from "@/i18n";
import { Answer, QuestionBox } from "@/lesson/aside-card";
import type { ReviewMessage } from "@/lib/assignments";
import { cn } from "@/lib/utils";
import { waitingReply, type LiveComment } from "./use-review";
import { saidBlocks } from "@/i18n/notice";

interface Exchange {
  reply: ReviewMessage;
  answer: { text: string; blocks: Block[] | null; streaming: boolean } | null;
}

/** The thread after the comment as replies, each with its answer (streaming, for the last one). */
function exchangesOf(
  thread: readonly ReviewMessage[],
  draft: string | null,
  t: Messages,
): Exchange[] {
  const exchanges: Exchange[] = [];
  for (const message of thread) {
    const last = exchanges.at(-1);
    if (message.role === "learner") exchanges.push({ reply: message, answer: null });
    else if (last && !last.answer)
      last.answer = {
        text: message.text,
        blocks: message.failure ? saidBlocks(message.failure, t) : message.blocks,
        streaming: false,
      };
  }
  const last = exchanges.at(-1);
  if (last && !last.answer) last.answer = { text: draft ?? "", blocks: null, streaming: true };
  return exchanges;
}

/**
 * A margin comment of the review, in the card asides use (design §7.4): the checklist items it bears
 * on, the comment, and the thread under it, the tutor's answer to a reply revealed as it streams.
 * Closed, the card shows the comment; open, its thread too and a box to reply in, until the
 * learner has found the flaw.
 */
export function ReviewThread(props: {
  comment: LiveComment;
  items: readonly ChecklistItem[];
  expanded: boolean;
  onReply: (text: string) => Promise<void>;
  onClose?: () => void;
}) {
  const { comment, expanded } = props;
  const all = useT();
  const t = all.homework;
  const [first, ...thread] = comment.messages;
  const waiting = waitingReply(comment);
  const resolved = comment.resolvedAt !== null;
  const replies = comment.messages.filter((m) => m.role === "learner").length;

  return (
    <div className="flex flex-col">
      <p className="mb-1.5 flex items-start gap-1.5 text-[11.5px] leading-snug text-muted-foreground">
        {resolved ? (
          <Check className="mt-px size-3.5 shrink-0 text-success" strokeWidth={3} aria-hidden />
        ) : (
          <Droplet className="mt-px size-3.5 shrink-0 text-primary" aria-hidden />
        )}
        <span className={cn(!expanded && "line-clamp-1")}>
          {resolved && t.found}
          {props.items.length > 0 ? props.items.map((i) => i.text).join(" · ") : t.lookAgain}
        </span>
      </p>
      {/* A comment is a few sentences: all of it shows, open or not. */}
      {first && <Answer text={first.text} blocks={first.blocks} streaming={false} />}
      {expanded &&
        exchangesOf(thread, comment.draft, all).map(({ reply, answer }) => (
          <div key={reply.id} className="mt-3 border-t pt-3">
            <p className="mb-1.5 text-[13px] leading-snug font-medium whitespace-pre-wrap text-foreground">
              <LearnerText text={reply.text} />
            </p>
            {/* Keyed by the reply, so the answer goes on revealing where it streamed. */}
            {answer && <Answer key={reply.id} {...answer} />}
          </div>
        ))}
      {!expanded && replies > 0 && (
        <p className="mt-2 text-[11.5px] text-subtle-foreground">{t.replies(replies)}</p>
      )}
      {expanded && resolved && (
        <p className="mt-3 flex items-center gap-1.5 rounded-md bg-success/10 px-2.5 py-1.5 text-[12.5px] text-success">
          <Check className="size-3.5" strokeWidth={3} aria-hidden />
          {t.youFoundIt}
        </p>
      )}
      {expanded && !resolved && (
        <QuestionBox
          label={t.yourReply}
          placeholder={waiting ? t.answering : t.lookAgainThenReply}
          submitLabel={t.reply}
          waiting={waiting !== null}
          onSubmit={props.onReply}
          onCancel={props.onClose}
        />
      )}
    </div>
  );
}
