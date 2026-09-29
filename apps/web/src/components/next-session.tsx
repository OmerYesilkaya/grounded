import type { ReactNode } from "react";
import { ExamOpenWarning, useStartSession } from "@/components/start-session";
import { Button } from "@/components/ui/button";
import type { TrackSummary } from "@/lib/tracks";

/**
 * What starts the track's next session, wherever one can be started (the track page, a closed
 * session's chat): a session, or, once the plan is taught through and the arc exams are in, the
 * final (design §7.4), with another session still open to the learner who wants to go on.
 */
export function NextSession({
  track,
  lead,
  label = "Start a session",
}: {
  track: Pick<TrackSummary, "id" | "final">;
  /** Said before the button, in a closed session: "This session is done." */
  lead?: ReactNode;
  label?: string;
}) {
  const start = useStartSession(track.id);
  const error = start.error && <p className="mt-3 text-sm text-destructive">{start.error}</p>;
  if (start.examOpen)
    return (
      <>
        <ExamOpenWarning
          exam={start.examOpen}
          pending={start.pending}
          onStartAnyway={start.start}
        />
        {error}
      </>
    );
  if (track.final === "ready")
    return (
      <>
        <FinalOffer
          pending={start.pending}
          onStartFinal={start.startFinal}
          onStartSession={start.start}
        />
        {error}
      </>
    );
  return (
    <>
      {track.final === "after-exam" && (
        <p className="mb-3 max-w-prose text-[14px] leading-relaxed text-muted-foreground">
          The plan is taught through. Once your arc exam is handed in, the track ends with its
          final.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {lead && <span className="text-sm text-muted-foreground">{lead}</span>}
        <Button size={lead ? "sm" : "default"} disabled={start.pending} onClick={start.start}>
          {label}
        </Button>
      </div>
      {error}
    </>
  );
}

/**
 * The final offered (design §7.4): the plan is taught through and the arc exams are in, so the
 * track can end. Going on with another session is the learner's choice too.
 */
export function FinalOffer(props: {
  pending: boolean;
  onStartFinal: () => void;
  onStartSession: () => void;
}) {
  return (
    <section
      aria-labelledby="final-offer"
      className="rounded-xl border border-primary/40 bg-card px-5 py-4.5 sm:px-6"
    >
      <p className="text-[11px] font-semibold tracking-[0.14em] text-primary uppercase">
        The final
      </p>
      <h2 id="final-offer" className="mt-1 font-serif text-[21px] leading-snug font-semibold">
        The plan is taught through
      </h2>
      <p className="mt-2 text-[14.5px] leading-relaxed text-muted-foreground">
        One last session, with no homework. First a fresh look at where you stand across the whole
        subject; then you explain it back from its foundations, while the tutor keeps asking why and
        what if. At the end you see what it found beside what was found along the way.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button disabled={props.pending} onClick={props.onStartFinal}>
          Start the final
        </Button>
        <Button variant="ghost" disabled={props.pending} onClick={props.onStartSession}>
          Another session first
        </Button>
      </div>
    </section>
  );
}
