import type { StepStatus, TermStatus } from "@grounded/core";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { Dialog } from "radix-ui";
import { Fragment, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { SessionSnapshot } from "@/lib/session";
import { useTracks } from "@/lib/tracks";
import { cn } from "@/lib/utils";

/*
 * Development only (design §10): the current track's terms as the method keeps them, with the
 * statuses the learner's pages translate or hide (planned, taught, confirmed, assumed), each term's
 * history, and on a session page each step's check as the session state has it. No model call:
 * everything here is read from what is stored. Opened with Alt+Shift+T; dropped from production
 * builds with the DEV branch in app-shell.tsx, and its route is off there too.
 */

/** A term as the dev route returns it (api: routes/dev.ts). */
export interface RawTerm {
  term: string;
  status: TermStatus;
  borrowedFrom: string | null;
  restsOn: string[];
  events: {
    from: TermStatus | null;
    to: TermStatus;
    evidence: string;
    source: string;
    at: string;
  }[];
}

const STATUSES: TermStatus[] = ["planned", "taught", "confirmed", "assumed"];

const STATUS_STYLE: Record<TermStatus, string> = {
  planned: "bg-muted text-muted-foreground",
  taught: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  confirmed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  assumed: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
};

const STEP_STYLE: Record<StepStatus, string> = {
  open: "bg-muted text-muted-foreground",
  passed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  settling: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  paused: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  unchecked: "bg-muted text-muted-foreground",
};

/** The chord that opens and closes the view: Alt+Shift+T, by key position (Alt changes the key). */
export const isTermStatesChord = (event: KeyboardEvent) =>
  event.code === "KeyT" && event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey;

const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 5)}`;
};

function Chip({ className, children }: { className: string; children: string }) {
  return (
    <span
      className={cn(
        "inline-block rounded px-1.5 py-0.5 font-mono text-[11px] leading-tight",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Listens for the chord from anywhere in the app and shows the view for the page's track. */
export function TermStates() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isTermStatesChord(event)) return;
      event.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  const params = useParams({ strict: false });
  const tracks = useTracks();
  const pageItemId = params.sessionId ?? params.assignmentId;
  const track =
    tracks.data?.find((t) => t.id === params.trackId) ??
    tracks.data?.find((t) => t.items.some((item) => item.id === pageItemId));

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[90dvh] w-[calc(100%-2rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border bg-popover text-popover-foreground shadow-lg"
        >
          <div className="flex items-baseline gap-3 border-b px-5 py-3">
            <Dialog.Title className="font-serif text-lg font-semibold">
              Terms as stored
            </Dialog.Title>
            <span className="text-xs text-muted-foreground">
              dev only · {track?.title ?? "no track on this page"} · Alt+Shift+T closes
            </span>
          </div>
          <div className="overflow-y-auto px-5 py-4 text-[13px]">
            {open && track && (
              <TrackTerms trackId={track.id} sessionId={params.sessionId ?? null} />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function TrackTerms({ trackId, sessionId }: { trackId: string; sessionId: string | null }) {
  const terms = useQuery({
    queryKey: ["dev", "terms", trackId],
    queryFn: () => api<{ terms: RawTerm[] }>(`/api/dev/tracks/${trackId}/terms`),
    staleTime: 0,
  });
  // The steps as the server has them now, not as the page's model has reduced them.
  const session = useQuery({
    queryKey: ["dev", "session", sessionId],
    queryFn: () => api<SessionSnapshot>(`/api/sessions/${sessionId ?? ""}`),
    enabled: sessionId !== null,
    staleTime: 0,
  });
  const [expanded, setExpanded] = useState<string | null>(null);

  if (terms.isError) return <p className="text-destructive">{terms.error.message}</p>;
  if (!terms.data) return <p className="text-muted-foreground">Loading…</p>;
  const all = terms.data.terms;
  const counts = STATUSES.map((status) => [status, all.filter((t) => t.status === status).length]);
  return (
    <>
      <dl className="mb-4 flex flex-wrap gap-x-5 gap-y-1">
        {counts.map(([status, count]) => (
          <div key={status} className="flex items-baseline gap-1.5">
            <dt>
              <Chip className={STATUS_STYLE[status as TermStatus]}>{String(status)}</Chip>
            </dt>
            <dd className="tabular-nums">{String(count)}</dd>
          </div>
        ))}
        <div className="flex items-baseline gap-1.5">
          <dt className="text-muted-foreground">borrowed</dt>
          <dd className="tabular-nums">{String(all.filter((t) => t.borrowedFrom).length)}</dd>
        </div>
      </dl>
      {all.length === 0 ? (
        <p className="text-muted-foreground">No terms yet.</p>
      ) : (
        <table className="w-full border-collapse">
          <thead className="text-left text-[11px] tracking-wider text-subtle-foreground uppercase">
            <tr>
              <th className="py-1 pr-3 font-medium">Term</th>
              <th className="py-1 pr-3 font-medium">Status</th>
              <th className="py-1 pr-3 font-medium">Rests on</th>
              <th className="py-1 font-medium">Latest change</th>
            </tr>
          </thead>
          <tbody>
            {all.map((t) => {
              const latest = t.events.at(-1);
              const isOpen = expanded === t.term;
              return (
                <Fragment key={t.term}>
                  <tr
                    className="cursor-pointer border-t align-top hover:bg-muted/60"
                    onClick={() => {
                      setExpanded(isOpen ? null : t.term);
                    }}
                  >
                    <td className="py-1.5 pr-3 font-medium">
                      <button type="button" className="text-left" aria-expanded={isOpen}>
                        {t.term}
                      </button>
                    </td>
                    <td className="py-1.5 pr-3">
                      <Chip className={STATUS_STYLE[t.status]}>{t.status}</Chip>
                      {t.borrowedFrom && (
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          borrowed from {t.borrowedFrom}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-muted-foreground">
                      {t.restsOn.join(", ") || "—"}
                    </td>
                    <td className="py-1.5 text-muted-foreground">
                      {latest ? (
                        <>
                          <span className="font-mono text-[11px]">{latest.source}</span>
                          {latest.evidence && <> · {latest.evidence}</>}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-muted/40">
                      <td colSpan={4} className="px-3 py-2">
                        <ol className="space-y-1">
                          {t.events.map((e, i) => (
                            <li key={i} className="flex flex-wrap items-baseline gap-x-2">
                              <span className="font-mono text-[11px] text-muted-foreground">
                                {when(e.at)}
                              </span>
                              <span className="font-mono text-[11px]">
                                {e.from ?? "∅"} → {e.to}
                              </span>
                              <span className="font-mono text-[11px] text-muted-foreground">
                                {e.source}
                              </span>
                              {e.evidence && <span>{e.evidence}</span>}
                            </li>
                          ))}
                        </ol>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      {session.data?.state.lesson.steps.length ? (
        <section className="mt-6">
          <h3 className="mb-2 text-[11px] tracking-wider text-subtle-foreground uppercase">
            This session's steps · phase {session.data.state.phase}
          </h3>
          <table className="w-full border-collapse">
            <tbody>
              {session.data.state.lesson.steps.map((step) => {
                const state = session.data.state.steps[step.id];
                return (
                  <tr key={step.id} className="border-t align-top">
                    <td className="py-1.5 pr-3 font-mono text-[12px]">
                      {step.id}
                      {session.data.state.currentStep === step.id && (
                        <span className="ml-1.5 text-[11px] text-muted-foreground">current</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3">
                      {state ? (
                        <>
                          <Chip className={STEP_STYLE[state.status]}>{state.status}</Chip>
                          {state.misses > 0 && (
                            <span className="ml-1.5 text-xs text-muted-foreground">
                              {String(state.misses)} missed
                            </span>
                          )}
                          {state.offerGate && (
                            <span className="ml-1.5 text-xs text-muted-foreground">
                              gate offered
                            </span>
                          )}
                          {state.pressed && (
                            <span className="ml-1.5 text-xs text-muted-foreground">pressed</span>
                          )}
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">not reached</span>
                      )}
                    </td>
                    <td className="py-1.5 text-muted-foreground">
                      {step.check
                        ? `checks ${step.check.terms.join(", ") || "(terms not recorded)"}${step.check.gates ? " · gates" : ""}`
                        : "no check"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ) : null}
    </>
  );
}
