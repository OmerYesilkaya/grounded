import type { ProbeVerdict, VerdictBand } from "@grounded/core/probe-verdict";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { WorkingMark } from "@/components/working-mark";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { SessionModel } from "@/lib/session";
import { cn } from "@/lib/utils";

/** The bands as the learner reads them, and how many of the three marks each fills. */
const BANDS: Record<VerdictBand, { label: string; level: number }> = {
  starting: { label: "Starting out", level: 1 },
  working: { label: "Working", level: 2 },
  solid: { label: "Solid", level: 3 },
};

/** A band: three short marks, filled up to it, and its name. Coarse on purpose, never a number. */
function Band({ band }: { band: VerdictBand }) {
  const { label, level } = BANDS[band];
  return (
    <span className="inline-flex shrink-0 items-center gap-2 text-[12px] text-muted-foreground">
      <span aria-hidden className="flex gap-0.5">
        {[1, 2, 3].map((n) => (
          <span
            key={n}
            className={cn("h-1.5 w-3.5 rounded-full", n <= level ? "bg-primary" : "bg-border")}
          />
        ))}
      </span>
      {label}
    </span>
  );
}

/**
 * What the first probe found, for the learner (design §7.1): the whole first, then each strand,
 * with its band. It says where things got shaky, never what the answer is: the lesson does.
 */
export function VerdictView({ verdict }: { verdict: ProbeVerdict }) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[11px] tracking-widest text-primary uppercase">Overall</p>
        <Band band={verdict.overall.band} />
      </div>
      <p className="mt-1.5 font-serif text-[17px] leading-[1.6]">{verdict.overall.text}</p>
      {verdict.strands.length > 0 && (
        <ul className="mt-4 flex flex-col divide-y border-t">
          {verdict.strands.map((strand) => (
            <li key={strand.name} className="py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h3 className="text-[14.5px] font-medium">{strand.name}</h3>
                <Band band={strand.band} />
              </div>
              <p className="mt-1 text-[14.5px] leading-relaxed text-muted-foreground">
                {strand.text}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * "See where you stand", at the seam between the first probe and the plan (design §7.1): offered,
 * never pushed. The verdict is written when the learner asks, and stays here once it is.
 */
export function VerdictSeam({ model }: { model: SessionModel }) {
  const ask = useMutation({
    mutationFn: () => api(`/api/sessions/${model.id}/verdict`, { method: "POST" }),
  });
  const state = model.verdict;
  if (!state) return null;

  if (state.status === "written" && state.verdict)
    return (
      <section
        aria-label="Where you stand"
        className="w-full rounded-xl border border-primary/30 bg-card px-5 py-4"
      >
        <h2 className="mb-3 text-[11px] tracking-widest text-subtle-foreground uppercase">
          Where you stand
        </h2>
        <VerdictView verdict={state.verdict} />
      </section>
    );

  const writing = state.status === "writing" || ask.isPending;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      {writing ? (
        <span className="inline-flex items-center gap-2 text-subtle-foreground">
          <WorkingMark className="size-4" />
          Working out where you stand…
        </span>
      ) : (
        <>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              ask.mutate();
            }}
          >
            {state.status === "failed" ? "Try again" : "See where you stand"}
          </Button>
          <span className="text-subtle-foreground">
            {state.status === "failed"
              ? (state.failure ?? "It couldn't be written.")
              : "What your answers showed, if you'd like to know."}
          </span>
        </>
      )}
      {ask.error && <p className="w-full text-destructive">{ask.error.message}</p>}
    </div>
  );
}

/** The track page's "Where you started" (design §8): the first probe's verdict, opened on a tap. */
export function WhereYouStarted({ verdict }: { verdict: ProbeVerdict }) {
  const [open, setOpen] = useState(false);
  const body = useId();
  return (
    <section className="mt-12 rounded-lg border bg-card">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={body}
        onClick={() => {
          setOpen(!open);
        }}
        className="flex w-full items-center gap-4 rounded-lg px-4 py-3 text-left transition-colors hover:bg-muted"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[14.5px] font-medium">Where you started</span>
          <span className="mt-0.5 block text-[12.5px] text-subtle-foreground">
            What your answers showed before the first lesson
          </span>
        </span>
        <Band band={verdict.overall.band} />
        <ChevronDown
          aria-hidden
          className={cn("size-4 shrink-0 text-subtle-foreground", open && "rotate-180")}
        />
      </button>
      {open && (
        <div id={body} className="border-t px-4 py-4">
          <VerdictView verdict={verdict} />
        </div>
      )}
    </section>
  );
}
