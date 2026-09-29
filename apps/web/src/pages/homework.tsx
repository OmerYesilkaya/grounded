import { answerProblem, TASK_FORM_SPECS } from "@grounded/core/assignment";
import { fieldLabel } from "@grounded/core/assignment-review";
import type { Snooze } from "@grounded/core/snooze";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, Check } from "lucide-react";
import { useRef, useState } from "react";
import { PageBar } from "@/components/page-bar";
import { Button } from "@/components/ui/button";
import { Blocks } from "@/content/blocks";
import { ContentProvider } from "@/content/environment";
import { fieldScope } from "@/homework/answer-view";
import { SelfCheck, useSelfCheck } from "@/homework/checklist";
import { LaterMenu } from "@/homework/later-menu";
import { ReviewCards, ReviewLayer } from "@/homework/review-layer";
import { ReviewSummary } from "@/homework/review-summary";
import { ExamPart, TaskAnswerArea } from "@/homework/task-part";
import { useAnswers, type SaveStatus } from "@/homework/use-answers";
import { useReview } from "@/homework/use-review";
import { assignmentApi, useAssignment, type Assignment } from "@/lib/assignments";
import { useMediaQuery } from "@/lib/media-query";
import { scrollBehavior } from "@/lib/motion";
import { dueWords, useNow } from "@/lib/snooze";
import { cn } from "@/lib/utils";

/** Wide enough for the margin's comments, as the lesson's (design §9.1); below, under each field. */
const WIDE = "(min-width: 1100px)";

/** The homework page, at /homework/:assignmentId. */
export function HomeworkRoute() {
  const { assignmentId } = useParams({ from: "/app/homework/$assignmentId" });
  const assignment = useAssignment(assignmentId);
  if (!assignment.data) return null;
  // A fresh page for each assignment: its answers start from what that one holds.
  return <HomeworkPage key={assignment.data.id} assignment={assignment.data} />;
}

/** "29 Sep, 14:30": when it was assigned or handed in. */
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * Homework or an arc exam on a page of its own (design §7.4): what it asks, the answer boxes of
 * its kind (an exam's parts each with their own), what a good answer shows to check against, and
 * handing it in, whole. It can be put off ("Later") till tonight or tomorrow, which closes the
 * session while that waits for its homework; it stays open in the track list either way, until it
 * is handed in or (homework) folded into a later homework.
 */
export function HomeworkPage({ assignment }: { assignment: Assignment }) {
  const queryClient = useQueryClient();
  const { answers, status, error, setError, change, lock, flush } = useAnswers(assignment);
  const [submittedAt, setSubmittedAt] = useState(assignment.submittedAt);
  const [waiting, setWaiting] = useState(assignment.session.waiting);
  const [snoozedUntil, setSnoozedUntil] = useState(assignment.snoozedUntil);
  const [busy, setBusy] = useState(false);
  const selfCheck = useSelfCheck(assignment.id);
  const handedIn = submittedAt !== null;
  // Folded into a later homework: closed, read only, and that one is the one to do.
  const closed = handedIn || assignment.subsumedBy !== null;
  const [task] = assignment.tasks;
  const exam = assignment.kind === "exam";

  // The review, once handed in: comments beside the answer, in the margin where there is room.
  const review = useReview(assignment);
  const comments = review?.status === "done" ? review.comments : [];
  const [active, setActive] = useState<string | null>(null);
  const wide = useMediaQuery(WIDE, true);
  const grid = useRef<HTMLDivElement>(null);
  const answer = useRef<HTMLElement>(null);
  const margin = useRef<HTMLElement>(null);
  const cards = {
    comments,
    checklist: assignment.checklist,
    active,
    onActivate: setActive,
    onReply: async (commentId: string, text: string) => {
      await assignmentApi.reply(assignment.id, commentId, text);
    },
  };
  /** A checklist item's comment, opened and brought into view. */
  const showComment = (itemId: string) => {
    const comment = comments.find((c) => c.items.includes(itemId));
    if (!comment) return;
    setActive(comment.id);
    const { taskId, field } = comment.anchor;
    const target = wide
      ? document.querySelector(`[data-step="${fieldScope(taskId, field)}"]`)
      : document.querySelector(`[data-review-card="${comment.id}"]`);
    target?.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
  };

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["assignment", assignment.id] }),
      queryClient.invalidateQueries({ queryKey: ["session", assignment.sessionId] }),
      queryClient.invalidateQueries({ queryKey: ["tracks"] }),
    ]);
  };

  const handIn = async () => {
    const problem = assignment.tasks
      .map((t) => answerProblem(t, answers[t.id], { complete: true }))
      .find(Boolean);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      await flush();
      const result = await assignmentApi.submit(assignment.id);
      setSubmittedAt(result.submittedAt);
      setError(null);
      await refresh();
    } catch (failed) {
      setError(failed instanceof Error ? failed.message : "It wasn't handed in. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const later = async (snooze: Snooze) => {
    setBusy(true);
    try {
      await flush();
      const result = await assignmentApi.later(assignment.id, snooze);
      setSnoozedUntil(result.snoozedUntil);
      setWaiting(false);
      setError(null);
      await refresh();
    } catch (failed) {
      setError(failed instanceof Error ? failed.message : "That didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  };

  /** A task's answer: its boxes, or once handed in, what was written with the review's comments. */
  const answerArea = (of: Assignment["tasks"][number]) => (
    <TaskAnswerArea
      task={of}
      answer={answers[of.id]}
      handedIn={handedIn}
      readOnly={closed}
      onChange={(key, value) => {
        change(of.id, key, value);
      }}
      onLock={() => lock(of.id)}
      upload={(file) => assignmentApi.picture(assignment.id, file)}
      onError={setError}
      after={
        comments.length && !wide ? (scope) => <ReviewCards {...cards} scope={scope} /> : undefined
      }
    />
  );

  if (!task) return null;
  return (
    <ContentProvider>
      <TopBar assignment={assignment} status={closed ? null : status} />
      <div
        ref={grid}
        className="relative grid grid-cols-[minmax(0,1fr)_minmax(0,68ch)_minmax(340px,1fr)] pt-12 pb-28 max-[1100px]:grid-cols-[minmax(16px,1fr)_minmax(0,68ch)_minmax(16px,1fr)]"
      >
        <main className="col-start-2 min-w-0">
          <p className="text-[11px] font-semibold tracking-[0.14em] text-primary uppercase">
            {exam
              ? `Arc exam · ${String(assignment.tasks.length)} parts`
              : `Homework · ${TASK_FORM_SPECS[task.form].label}`}
          </p>
          <h1 className="mt-2 font-serif text-[30px] leading-tight font-semibold tracking-tight text-balance">
            {assignment.title}
          </h1>
          <p className="mt-2 text-[13px] text-subtle-foreground">
            From session {assignment.session.number} of {assignment.trackTitle} · set{" "}
            {when(assignment.createdAt)}
          </p>

          {exam ? (
            !closed && <OneSitting />
          ) : (
            <article className="mt-8 font-serif text-[17px] leading-[1.7] text-foreground">
              <Blocks blocks={task.blocks} />
            </article>
          )}

          {review ? (
            <div className="mt-8">
              <ReviewSummary
                review={review}
                checklist={assignment.checklist}
                onShowComment={showComment}
                onAgain={async () => {
                  await assignmentApi.reviewAgain(assignment.id);
                }}
              />
            </div>
          ) : (
            <div className="mt-6 min-[1100px]:hidden">
              <SelfCheck
                items={assignment.checklist}
                ticked={selfCheck.ticked}
                onToggle={selfCheck.toggle}
                readOnly={closed}
              />
            </div>
          )}

          {exam ? (
            // Every part, each with its own boxes; the review's comments find their words in all.
            <article ref={answer} aria-label="The exam">
              {assignment.tasks.map((part, i) => (
                <ExamPart key={part.id} task={part} number={i + 1}>
                  {answerArea(part)}
                </ExamPart>
              ))}
            </article>
          ) : (
            <section ref={answer} aria-label="Your answer" className="mt-10 border-t pt-8">
              {answerArea(task)}
            </section>
          )}

          {assignment.subsumedBy ? (
            <Folded into={assignment.subsumedBy} />
          ) : (
            <HandIn
              exam={exam}
              submittedAt={submittedAt}
              snoozedUntil={snoozedUntil}
              waiting={waiting}
              busy={busy}
              error={error}
              onHandIn={() => void handIn()}
              onLater={(snooze) => void later(snooze)}
            />
          )}
        </main>
        {/* The right margin: what a good answer shows, then (reviewed) the review's comments. */}
        <aside
          ref={margin}
          aria-label={review?.status === "done" ? "Comments" : "A good answer shows"}
          className="col-start-3 mr-5 ml-10 max-w-[300px] max-[1100px]:hidden"
        >
          {review?.status !== "done" && (
            <div className="sticky top-24">
              <SelfCheck
                items={assignment.checklist}
                ticked={selfCheck.ticked}
                onToggle={selfCheck.toggle}
                readOnly={closed}
              />
            </div>
          )}
        </aside>
        {comments.length > 0 && (
          <ReviewLayer
            {...cards}
            grid={grid}
            answer={answer}
            margin={margin}
            wide={wide}
            fieldLabel={(comment) => {
              const on = assignment.tasks.find((t) => t.id === comment.anchor.taskId) ?? task;
              const label = fieldLabel(on.form, comment.anchor.field);
              return on.title ? `${on.title}: ${label}` : label;
            }}
          />
        )}
      </div>
    </ContentProvider>
  );
}

const SAVE_WORDS: Record<SaveStatus, string> = {
  saved: "Saved",
  saving: "Saving…",
  failed: "Not saved",
};

/** The page's header band, level with the sidebar's: the way back to its session, and saving. */
function TopBar({ assignment, status }: { assignment: Assignment; status: SaveStatus | null }) {
  return (
    <PageBar
      start={
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: assignment.sessionId }}
          className="touch-target relative flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] whitespace-nowrap text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Session {assignment.session.number}
        </Link>
      }
      end={
        status && (
          <span
            role="status"
            className={cn(
              "text-[12px] text-subtle-foreground",
              status === "failed" && "text-destructive",
            )}
          >
            {SAVE_WORDS[status]}
          </span>
        )
      }
    />
  );
}

/**
 * How an arc exam is taken (method.md, "The arc exam"): in one sitting, whole. What is written is
 * kept as it is written, but nothing is handed in, or reviewed, until every part is answered.
 */
function OneSitting() {
  return (
    <p className="mt-6 border-l-2 border-primary/50 pl-4 text-[14.5px] leading-relaxed text-muted-foreground">
      Everything here is new ground, built from the whole arc. Take it in one sitting, when you have
      room for it: your answers are kept as you write, and it is handed in, and reviewed, only once
      every part is answered. If now isn't the time, put it off with Later.
    </p>
  );
}

/** Folded into a later homework (method.md, "Homework"): that one covers this one's ground. */
function Folded({ into }: { into: { id: string; title: string } }) {
  return (
    <div className="mt-12 rounded-xl border bg-card px-4 py-3.5 text-[14px]">
      Folded into a later homework, which covers this one too:{" "}
      <Link
        to="/homework/$assignmentId"
        params={{ assignmentId: into.id }}
        className="font-medium text-primary underline-offset-2 hover:underline"
      >
        {into.title}
      </Link>
      .
    </div>
  );
}

/**
 * Handing it in (whole, never half-done), or putting it off till tonight or tomorrow: "Later"
 * closes the session while it waits for this, and can put the homework off again after.
 */
function HandIn(props: {
  exam: boolean;
  submittedAt: string | null;
  snoozedUntil: string | null;
  waiting: boolean;
  busy: boolean;
  error: string | null;
  onHandIn: () => void;
  onLater: (snooze: Snooze) => void;
}) {
  const now = useNow();
  if (props.submittedAt)
    return (
      <div className="mt-12 flex items-center gap-2.5 rounded-xl border bg-card px-4 py-3.5 text-[14px]">
        <span className="flex size-5 items-center justify-center rounded-full bg-success/15 text-success">
          <Check className="size-3.5" strokeWidth={3} aria-hidden />
        </span>
        Handed in {when(props.submittedAt)}.
      </div>
    );
  return (
    <div className="mt-12 border-t pt-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" disabled={props.busy} onClick={props.onHandIn}>
          Hand it in
        </Button>
        <LaterMenu disabled={props.busy} onChoose={props.onLater} />
        <span className="text-[12.5px] text-subtle-foreground">
          {props.waiting
            ? "Later closes the session; the homework waits in your track until then."
            : `${props.snoozedUntil ? dueWords(props.snoozedUntil, now) : "Open:"} it waits in your track until you hand it in${props.exam ? ", every part answered" : ""}.`}
        </span>
      </div>
      {props.error && (
        <p role="alert" className="mt-3 text-[13px] text-destructive">
          {props.error}
        </p>
      )}
    </div>
  );
}
