import type { CitedSource } from "@grounded/content";
import { createContext, useContext, type ReactNode } from "react";
import { useT } from "@/i18n";
import { hostname } from "./visual-blocks";

/** The lesson's sources in the order its "Sources" list numbers them; none outside a lesson. */
const Cited = createContext<readonly CitedSource[]>([]);

export function CitationsProvider(props: { sources: readonly CitedSource[]; children: ReactNode }) {
  return <Cited.Provider value={props.sources}>{props.children}</Cited.Provider>;
}

/** Where the lesson's "Sources" list holds source `n`. */
const sourceAnchor = (n: number) => `lesson-source-${String(n)}`;

/**
 * A citation's mark (design §9.1): the number of its source in the lesson's "Sources" list, linked
 * to it. One the list doesn't hold (outside a lesson) shows nothing. It isn't the lesson's text, so
 * a passage asked about leaves it out (`data-cite`, passages.ts).
 */
export function CitationMark({ source }: { source: CitedSource | null }) {
  const sources = useContext(Cited);
  const n = source ? sources.findIndex((s) => s.url === source.url) + 1 : 0;
  if (!source || n === 0) return null;
  return (
    <sup data-cite className="ml-px font-sans text-[0.68em] leading-none">
      <a
        href={`#${sourceAnchor(n)}`}
        title={source.title}
        className="text-primary no-underline hover:underline"
      >
        [{n}]
      </a>
    </sup>
  );
}

/**
 * Below the lesson (design §9.1): the sources it cites, numbered as its marks are, each opening the
 * page itself, and what the rest rests on: the tutor's own knowledge, checked against nothing.
 */
export function LessonSources({ sources }: { sources: readonly CitedSource[] }) {
  const t = useT().lesson.sources;
  return (
    <section aria-label={t.heading} className="mt-12 border-t pt-6 font-sans text-sm">
      {sources.length > 0 && (
        <>
          <h2 className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
            {t.heading}
          </h2>
          <ol className="mb-4 list-decimal space-y-1 pl-6">
            {sources.map((source, i) => (
              <li key={source.url} id={sourceAnchor(i + 1)} className="scroll-mt-20">
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground underline decoration-border-strong underline-offset-2 hover:decoration-primary"
                >
                  {source.title}
                </a>
                {/* A source the provider gave no title is named by its site already. */}
                {source.title !== hostname(source.url) && (
                  <span className="text-subtle-foreground"> · {hostname(source.url)}</span>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
      <p className="text-subtle-foreground">{t.uncited}</p>
    </section>
  );
}
