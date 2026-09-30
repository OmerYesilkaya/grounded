import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { api, ApiError } from "@/lib/api";

interface OpenExam {
  id: string;
  title: string;
}

/** The exam the server's refusal names, when it refused because an arc exam is still open. */
function openExamOf(error: unknown): OpenExam | null {
  if (!(error instanceof ApiError) || error.notice?.code !== "exam-open") return null;
  const exam = error.body?.exam as Partial<OpenExam> | undefined;
  return exam?.id && exam.title ? { id: exam.id, title: exam.title } : null;
}

/**
 * Starting a track's next session, or its final (design §7.4), and going to it. With an arc exam
 * still open the server says so once: `examOpen` is that exam, for the warning, and starting again
 * starts it.
 */
export function useStartSession(trackId: string) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [examOpen, setExamOpen] = useState<OpenExam | null>(null);
  const start = useMutation({
    mutationFn: (kind: "normal" | "final") =>
      api<{ id: string }>(`/api/tracks/${trackId}/sessions`, {
        method: "POST",
        body: JSON.stringify({ kind }),
      }),
    onSuccess: async ({ id }) => {
      setExamOpen(null);
      await queryClient.invalidateQueries({ queryKey: ["tracks"] });
      void navigate({ to: "/sessions/$sessionId", params: { sessionId: id } });
    },
    onError: (error) => {
      setExamOpen(openExamOf(error));
    },
  });
  return {
    start: () => {
      start.mutate("normal");
    },
    startFinal: () => {
      start.mutate("final");
    },
    pending: start.isPending,
    examOpen,
    /** A failure to show; the warning about an open exam isn't one. */
    error: examOpen || !start.error ? null : start.error.message,
  };
}

/**
 * The one warning (design §7.4, method.md "The arc exam"): the next arc is about to build on one
 * whose exam is still open. Taking it first is the way the method goes; starting anyway is allowed,
 * and the session's first questions then come back to some of the exam's ideas.
 */
export function ExamOpenWarning(props: {
  exam: OpenExam;
  pending: boolean;
  onStartAnyway: () => void;
}) {
  const t = useT().track.start;
  return (
    <div
      role="alert"
      className="rounded-xl border border-primary/40 bg-card px-5 py-4 text-[14px] leading-relaxed"
    >
      <p className="text-[11px] font-semibold tracking-[0.14em] text-primary uppercase">
        {t.examOpen}
      </p>
      <p className="mt-1.5 font-serif text-[17px] leading-snug font-semibold">{props.exam.title}</p>
      <p className="mt-1.5 text-muted-foreground">{t.examOpenWhy}</p>
      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <Button asChild size="sm">
          <Link to="/homework/$assignmentId" params={{ assignmentId: props.exam.id }}>
            {t.takeExam}
            <ArrowRight aria-hidden />
          </Link>
        </Button>
        <Button size="sm" variant="outline" disabled={props.pending} onClick={props.onStartAnyway}>
          {t.startAnyway}
        </Button>
      </div>
    </div>
  );
}
