import type { SourceReading, SourceSectionView } from "@grounded/core/sources";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFormat, useT } from "@/i18n";
import { wordNotice } from "@/i18n/notice";
import { readSource, sourceQuery } from "@/lib/source";
import { cn } from "@/lib/utils";

/**
 * Where reading a track's source stands (design §4.6), until it is read: the survey under way, the
 * estimate the learner agrees to before anything is spent, the reading's progress, or why it
 * stopped. Sessions start once it is read.
 */
export function SourceReadingCard({
  trackId,
  reading,
}: {
  trackId: string;
  reading: SourceReading;
}) {
  const all = useT();
  const t = all.track.source;
  const format = useFormat();
  const n = (value: number) => format.number(value);
  const queryClient = useQueryClient();
  const read = useMutation({
    mutationFn: () => readSource(trackId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tracks"] }),
  });

  const card = (title: string, children: React.ReactNode) => (
    <section
      aria-label={t.title}
      className="rounded-xl border bg-card px-5 py-4.5 text-[14.5px] leading-relaxed sm:px-6"
    >
      <p className="text-[11px] font-semibold tracking-[0.14em] text-primary uppercase">
        {t.title}
      </p>
      <h2 className="mt-1 font-serif text-[19px] leading-snug font-semibold">{title}</h2>
      {children}
      {read.error && <p className="mt-3 text-sm text-destructive">{read.error.message}</p>}
    </section>
  );

  switch (reading.status) {
    case "surveying":
      return card(t.surveying, <p className="mt-1.5 text-muted-foreground">{t.surveyingNote}</p>);
    case "awaiting": {
      const cost =
        reading.estimate === null
          ? null
          : reading.estimate < 0.01
            ? t.underACent
            : format.number(reading.estimate, { style: "currency", currency: "USD" });
      const facts = [
        ...(reading.pages > 0
          ? [
              t.pages(n(reading.pages)),
              reading.transcribe > 0 ? t.toTranscribe(n(reading.transcribe)) : t.allText,
            ]
          : []),
        t.sections(n(reading.sections)),
      ];
      return card(
        t.awaitingTitle,
        <>
          <p className="mt-1.5 text-muted-foreground">{facts.join(" · ")}</p>
          <p className="mt-2">{cost === null ? t.estimateUnknown : t.estimate(cost)}</p>
          <p className="mt-2 text-muted-foreground">{t.awaitingNote}</p>
          <Button
            className="mt-4"
            disabled={read.isPending}
            onClick={() => {
              read.mutate();
            }}
          >
            {t.read}
          </Button>
        </>,
      );
    }
    case "reading": {
      const summarizing = reading.transcribed >= reading.transcribe && reading.summarized > 0;
      const [done, of] =
        reading.transcribe > 0 && !summarizing
          ? [reading.transcribed, reading.transcribe]
          : [reading.summarized, reading.sections];
      const line =
        reading.transcribe > 0 && !summarizing
          ? t.transcribing(n(done), n(of))
          : t.summarizing(n(done), n(of));
      return card(
        t.reading,
        <>
          <p className="mt-1.5">{line}</p>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={of}
            aria-valuenow={done}
            aria-label={line}
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${String(of ? (done / of) * 100 : 0)}%` }}
            />
          </div>
          <p className="mt-2 text-muted-foreground">{t.readingNote}</p>
        </>,
      );
    }
    case "failed": {
      const again =
        reading.failure?.code === "source-reading-stopped" ||
        reading.failure?.code === "source-needs-vision";
      return card(
        t.failedTitle,
        <>
          {reading.failure && (
            <p role="alert" className="mt-1.5 text-muted-foreground">
              {wordNotice(reading.failure, all)}
            </p>
          )}
          {again && (
            <Button
              className="mt-4"
              variant="outline"
              disabled={read.isPending}
              onClick={() => {
                read.mutate();
              }}
            >
              {t.tryAgain}
            </Button>
          )}
        </>,
      );
    }
    case "ready":
      return null;
  }
}

const STATUSES: readonly SourceSectionView["status"][] = ["taught", "known", "planned", "ahead"];

/** Above this many sections, the list opens on request. */
const OPEN_UP_TO = 12;

/**
 * How much of the source the track has covered (design §4.6): a count by status, then each
 * section with its pages and where the track stands with it.
 */
export function SourceCoverageView({ trackId }: { trackId: string }) {
  const coverage = useQuery(sourceQuery(trackId));
  const t = useT().track.source;
  const format = useFormat();
  const sections = coverage.data?.sections ?? [];
  if (sections.length === 0) return null;
  const counts = STATUSES.map((status) => ({
    status,
    count: sections.filter((s) => s.status === status).length,
  })).filter((c) => c.count > 0);
  const several = new Set(sections.map((s) => s.source)).size > 1;
  const list = (
    <ol className="mt-3 divide-y border-y text-[14px]">
      {sections.map((section) => (
        <li key={section.n} className="flex items-baseline gap-3 py-2">
          <span className="w-7 shrink-0 text-right text-xs text-subtle-foreground tabular-nums">
            {section.n}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate">{section.title}</span>
            {(section.pages !== null || several) && (
              <span className="block truncate text-xs text-subtle-foreground">
                {[several ? section.source : null, section.pages].filter(Boolean).join(" · ")}
              </span>
            )}
          </span>
          <span
            className={cn(
              "shrink-0 text-xs",
              section.status === "taught" && "font-medium text-primary",
              section.status === "known" && "text-foreground",
              (section.status === "planned" || section.status === "ahead") &&
                "text-subtle-foreground",
            )}
          >
            {t.status[section.status]}
          </span>
        </li>
      ))}
    </ol>
  );
  return (
    <section className="mt-12">
      <h2 className="text-xs tracking-widest text-subtle-foreground uppercase">{t.coverage}</h2>
      <p className="mt-1.5 text-[13px] text-muted-foreground">{t.coverageNote}</p>
      <p className="mt-3 text-sm">
        {counts.map((c) => `${format.number(c.count)} ${t.counts[c.status]}`).join(" · ")}
      </p>
      {sections.length > OPEN_UP_TO ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm text-primary">
            {t.showSections(format.number(sections.length))}
          </summary>
          {list}
        </details>
      ) : (
        list
      )}
    </section>
  );
}

/** The small mark a source track carries in the track list. */
export function SourceMarker({ className }: { className?: string }) {
  const t = useT().track.source;
  return (
    <BookOpen
      role="img"
      aria-label={t.marker}
      className={cn("size-3.5 shrink-0 text-subtle-foreground", className)}
    />
  );
}
