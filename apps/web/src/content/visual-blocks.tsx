import type { Block, DiagramFrame } from "@grounded/content";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useContentEnvironment } from "./environment";

const figureClass = "my-6 rounded-lg border bg-card px-4 pt-5 pb-3";
const captionClass = "mt-3 text-center font-sans text-[13.5px] text-muted-foreground";

type Rendered = { svg: string } | { failed: true } | null;

function useDiagram(source: string, highlight: string | null): Rendered {
  const { diagrams, theme } = useContentEnvironment();
  const key = `${theme}\u0000${highlight ?? ""}\u0000${source}`;
  // The result remembers what it was rendered from; a stale one reads as "not rendered yet".
  const [result, setResult] = useState<{ key: string; rendered: Exclude<Rendered, null> } | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    diagrams.render(source, { highlight, theme }).then(
      (svg) => {
        if (!cancelled) setResult({ key, rendered: { svg } });
      },
      () => {
        if (!cancelled) setResult({ key, rendered: { failed: true } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [diagrams, source, highlight, theme, key]);
  return result?.key === key ? result.rendered : null;
}

function Drawing({ source, highlight }: { source: string; highlight: string | null }) {
  const rendered = useDiagram(source, highlight);
  if (rendered === null) return <div className="h-24 animate-pulse rounded-md bg-muted/40" />;
  if ("failed" in rendered) {
    return (
      <p className="py-6 text-center font-sans text-sm text-subtle-foreground">
        Diagram unavailable
      </p>
    );
  }
  // Mermaid output in strict mode: sanitized labels, no scripts.
  return (
    <div
      className="flex justify-center [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: rendered.svg }}
    />
  );
}

export function DiagramView({ block }: { block: Extract<Block, { type: "diagram" }> }) {
  return (
    <figure data-block={block.id} aria-label={block.caption} className={figureClass}>
      <Drawing source={block.source} highlight={block.highlight} />
      <figcaption className={captionClass}>{block.caption}</figcaption>
    </figure>
  );
}

export function StepperView({ block }: { block: Extract<Block, { type: "stepper" }> }) {
  const [index, setIndex] = useState(0);
  const frame: DiagramFrame | undefined = block.frames[index];
  if (!frame) return null;
  const last = block.frames.length - 1;
  return (
    <figure data-block={block.id} aria-label={frame.caption} className={figureClass}>
      <Drawing source={frame.source} highlight={frame.highlight ?? null} />
      <figcaption className="mt-3 min-h-10 text-center font-sans text-sm text-foreground">
        {frame.caption}
      </figcaption>
      <div className="mt-2 flex items-center justify-center gap-3 font-sans text-[13px] text-muted-foreground">
        <button
          type="button"
          aria-label="Previous frame"
          disabled={index === 0}
          onClick={() => {
            setIndex(index - 1);
          }}
          className="rounded-md border bg-muted p-1 disabled:opacity-35"
        >
          <ChevronLeft className="size-4" />
        </button>
        <input
          type="range"
          aria-label="Frame"
          min={0}
          max={last}
          value={index}
          onChange={(event) => {
            setIndex(Number(event.target.value));
          }}
          className="w-40 accent-primary"
        />
        <span>
          {index + 1} / {block.frames.length}
        </span>
        <button
          type="button"
          aria-label="Next frame"
          disabled={index === last}
          onClick={() => {
            setIndex(index + 1);
          }}
          className="rounded-md border bg-muted p-1 disabled:opacity-35"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
    </figure>
  );
}

export function ChartView({ block }: { block: Extract<Block, { type: "chart" }> }) {
  const { charts, theme } = useContentEnvironment();
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    charts.mount(element, block.spec, theme).then(
      (dispose) => {
        if (cancelled) dispose();
        else cleanup = dispose;
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [charts, block.spec, theme]);
  return (
    <figure data-block={block.id} className={figureClass}>
      {failed ? (
        <p className="py-6 text-center font-sans text-sm text-subtle-foreground">
          Chart unavailable
        </p>
      ) : (
        <div ref={ref} className="flex justify-center overflow-x-auto" />
      )}
      {block.source && (
        <figcaption className={captionClass}>
          Source:{" "}
          <a
            href={block.source}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            {hostname(block.source)}
          </a>
        </figcaption>
      )}
    </figure>
  );
}

export function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
