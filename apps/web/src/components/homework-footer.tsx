import type { Snooze } from "@grounded/core/snooze";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LaterMenu } from "@/homework/later-menu";
import { duePrefix } from "@/homework/words";
import { useFormat, useT } from "@/i18n";
import { assignmentApi } from "@/lib/assignments";
import type { SessionModel } from "@/lib/session";
import { useNow } from "@/lib/snooze";

/**
 * Under the homework's or the arc exam's message in the chat (design §7.4): the way to its page,
 * and "Later" with a snooze. Homework is put off from here while the session waits for it, which
 * closes the session and leaves the homework open, due at the time chosen; an exam never holds the
 * session, and can be put off whenever it is open.
 */
export function HomeworkFooter({ model, messageId }: { model: SessionModel; messageId: string }) {
  const queryClient = useQueryClient();
  const assignment = model.assignments.find((a) => a.messageId === messageId);
  const now = useNow();
  const t = useT().homework;
  const format = useFormat();
  const later = useMutation({
    mutationFn: ({ id, snooze }: { id: string; snooze: Snooze }) => assignmentApi.later(id, snooze),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tracks"] }),
  });
  // Written before homework could be handed in: the message is all there is.
  if (!assignment) return null;
  const { state } = model;
  const exam = assignment.kind === "exam";
  const waiting = !exam && state.phase === "homework" && state.homework === "assigned";
  const handedIn = assignment.submittedAt !== null;
  const folded = assignment.subsumedBy !== null;
  const due = assignment.snoozedUntil ? duePrefix(assignment.snoozedUntil, now, t, format) : null;

  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-3.5">
      <Button asChild size="sm" variant={handedIn ? "outline" : "default"}>
        <Link to="/homework/$assignmentId" params={{ assignmentId: assignment.id }}>
          {handedIn ? t.seeReview : folded ? t.seeIt : exam ? t.openExam : t.openHomework}
          <ArrowRight aria-hidden />
        </Link>
      </Button>
      {handedIn ? (
        <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <Check className="size-3.5 text-success" strokeWidth={3} aria-hidden />
          {!exam && state.phase === "homework" && state.homework === "reviewing"
            ? t.handedInReviewing
            : t.handedIn}
        </span>
      ) : folded ? (
        <span className="text-[12.5px] text-subtle-foreground">{t.foldedCovers}</span>
      ) : waiting || exam ? (
        <>
          <LaterMenu
            size="sm"
            disabled={later.isPending}
            onChoose={(snooze) => {
              later.mutate({ id: assignment.id, snooze });
            }}
          />
          <span className="text-[12.5px] text-subtle-foreground">
            {exam ? t.examSitting(due) : t.laterCloses}
          </span>
        </>
      ) : (
        <span className="text-[12.5px] text-subtle-foreground">{t.stillOpen(due)}</span>
      )}
      {later.error && (
        <p role="alert" className="w-full text-[13px] text-destructive">
          {later.error.message}
        </p>
      )}
    </div>
  );
}
