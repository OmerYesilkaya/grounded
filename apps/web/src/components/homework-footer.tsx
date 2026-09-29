import type { Snooze } from "@grounded/core/snooze";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LaterMenu } from "@/homework/later-menu";
import { assignmentApi } from "@/lib/assignments";
import type { SessionModel } from "@/lib/session";
import { dueWords, useNow } from "@/lib/snooze";

/**
 * Under the homework's message in the chat (design §7.4): the way to its page, and while the
 * session waits for it, "Later" with a snooze, which closes the session and leaves the homework
 * open, due at the time chosen.
 */
export function HomeworkFooter({ model, messageId }: { model: SessionModel; messageId: string }) {
  const queryClient = useQueryClient();
  const assignment = model.assignments.find((a) => a.messageId === messageId);
  const now = useNow();
  const later = useMutation({
    mutationFn: ({ id, snooze }: { id: string; snooze: Snooze }) => assignmentApi.later(id, snooze),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tracks"] }),
  });
  // Written before homework could be handed in: the message is all there is.
  if (!assignment) return null;
  const { state } = model;
  const waiting = state.phase === "homework" && state.homework === "assigned";
  const handedIn = assignment.submittedAt !== null;
  const folded = assignment.subsumedBy !== null;

  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-3.5">
      <Button asChild size="sm" variant={handedIn ? "outline" : "default"}>
        <Link to="/homework/$assignmentId" params={{ assignmentId: assignment.id }}>
          {handedIn ? "See what you handed in" : folded ? "See it" : "Open the homework"}
          <ArrowRight aria-hidden />
        </Link>
      </Button>
      {handedIn ? (
        <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <Check className="size-3.5 text-success" strokeWidth={3} aria-hidden />
          Handed in
        </span>
      ) : folded ? (
        <span className="text-[12.5px] text-subtle-foreground">
          Folded into a later homework, which covers it too.
        </span>
      ) : waiting ? (
        <>
          <LaterMenu
            size="sm"
            disabled={later.isPending}
            onChoose={(snooze) => {
              later.mutate({ id: assignment.id, snooze });
            }}
          />
          <span className="text-[12.5px] text-subtle-foreground">
            Later closes the session; the homework waits in your track until then.
          </span>
        </>
      ) : (
        <span className="text-[12.5px] text-subtle-foreground">
          {assignment.snoozedUntil ? `${dueWords(assignment.snoozedUntil, now)} ` : "Still open: "}
          it waits in your track until you hand it in.
        </span>
      )}
      {later.error && (
        <p role="alert" className="w-full text-[13px] text-destructive">
          {later.error.message}
        </p>
      )}
    </div>
  );
}
