import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { layers, type MapNode, type Standing, type TermMap } from "@/lib/term-map";
import { cn } from "@/lib/utils";

/** The learner's words for where they stand (design §8), for the key under a picture. */
export const STANDING_LABEL: Record<Standing, string> = {
  owned: "You own it",
  settling: "Still settling",
  coming: "Coming up",
};

/**
 * Solid ground is filled in, what is still settling only outlined, and what is still to be built
 * dashed: the picture reads as building on solid ground.
 */
const nodeClass: Record<Standing, string> = {
  owned: "border-primary bg-highlight",
  settling: "border-primary/50 bg-background",
  coming: "border-dashed border-border-strong bg-background",
};

interface Line {
  from: string;
  to: string;
  d: string;
  end: { x: number; y: number };
}

/**
 * A picture of what rests on what (design §3.2, §9.1): each idea sits above what it rests on, the
 * ground at the bottom, with a line down to each thing under it. Drawn by the app from the term
 * dependencies, never by the model. The ideas it is drawn around are in full colour; what they rest
 * on is paler. Pointing at an idea follows its lines; `onSelect` makes the ideas buttons.
 */
export function TermMapPicture({
  map,
  selected,
  onSelect,
  label,
  className,
}: {
  map: TermMap;
  selected?: string | null;
  onSelect?: (node: MapNode) => void;
  /** What the picture shows, for screen readers. */
  label: string;
  className?: string;
}) {
  const rows = useMemo(() => layers(map), [map]);
  const byName = useMemo(() => new Map(map.nodes.map((n) => [n.term, n])), [map]);
  const box = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [pointed, setPointed] = useState<string | null>(null);
  const active = pointed ?? selected ?? null;

  // The lines follow the ideas wherever the rows wrap them, so they are drawn after layout, and
  // again whenever the picture changes size (a narrower column, the fonts arriving).
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => {
      const origin = element.getBoundingClientRect();
      const rect = (term: string) =>
        element.querySelector(`[data-term="${CSS.escape(term)}"]`)?.getBoundingClientRect();
      const next: Line[] = [];
      for (const { term, restsOn } of map.edges) {
        const top = rect(term);
        const bottom = rect(restsOn);
        if (!top || !bottom || term === restsOn) continue;
        const x1 = top.left + top.width / 2 - origin.left;
        const y1 = top.bottom - origin.top;
        const x2 = bottom.left + bottom.width / 2 - origin.left;
        const y2 = bottom.top - origin.top;
        const bend = Math.max(12, (y2 - y1) / 2);
        next.push({
          from: term,
          to: restsOn,
          d: ["M", x1, y1, "C", x1, y1 + bend, x2, y2 - bend, x2, y2].join(" "),
          end: { x: x2, y: y2 },
        });
      }
      setLines(next);
      setSize({ width: origin.width, height: origin.height });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    // Not every environment has font loading (tests run in jsdom).
    if ("fonts" in document) void document.fonts.ready.then(measure);
    return () => {
      observer?.disconnect();
    };
  }, [map, rows]);

  if (map.nodes.length === 0) return null;
  const linked = (line: Line) => active !== null && (line.from === active || line.to === active);
  const near = new Set(
    active
      ? [active, ...lines.filter(linked).flatMap((l) => [l.from, l.to])]
      : map.nodes.map((n) => n.term),
  );

  return (
    <div className={cn("font-sans", className)}>
      <div ref={box} role="img" aria-label={label} className="relative">
        <svg
          aria-hidden
          width={size.width}
          height={size.height}
          className="pointer-events-none absolute inset-0 overflow-visible"
        >
          {lines.map((line) => (
            <g
              key={`${line.from}\u0000${line.to}`}
              className={cn(
                "transition-opacity duration-150",
                linked(line)
                  ? "text-primary"
                  : byName.get(line.from)?.focus
                    ? "text-border-strong"
                    : "text-border",
                active !== null && !linked(line) && "opacity-30",
              )}
            >
              <path d={line.d} fill="none" stroke="currentColor" strokeWidth={1.25} />
              <circle cx={line.end.x} cy={line.end.y} r={2} fill="currentColor" />
            </g>
          ))}
        </svg>
        <div className="relative flex flex-col gap-8">
          {rows.map((row, r) => (
            <div key={r} className="flex flex-wrap justify-center gap-x-2.5 gap-y-3">
              {row.map((term) => {
                const node = byName.get(term);
                if (!node) return null;
                return (
                  <Idea
                    key={term}
                    node={node}
                    dimmed={!near.has(term)}
                    selected={selected === term}
                    onPoint={(on) => {
                      setPointed(on ? term : null);
                    }}
                    {...(onSelect ? { onSelect } : {})}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <Key map={map} />
    </div>
  );
}

function Idea({
  node,
  dimmed,
  selected,
  onPoint,
  onSelect,
}: {
  node: MapNode;
  dimmed: boolean;
  selected: boolean;
  onPoint: (on: boolean) => void;
  onSelect?: (node: MapNode) => void;
}) {
  const className = cn(
    "relative max-w-[15rem] rounded-[4px] border px-2.5 py-1 text-center text-[13px] leading-snug transition-opacity duration-150",
    nodeClass[node.standing],
    // What the picture is drawn around stands out; what it rests on is paler.
    node.focus ? "text-foreground" : "opacity-75 text-muted-foreground",
    dimmed && "opacity-35",
    selected && "ring-2 ring-ring",
    onSelect &&
      "cursor-pointer hover:border-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
  );
  const content = (
    <>
      <span className="block">{node.term}</span>
      {node.from && (
        <span className="block text-[10.5px] text-subtle-foreground">from {node.from}</span>
      )}
    </>
  );
  const pointing = {
    onMouseEnter: () => {
      onPoint(true);
    },
    onMouseLeave: () => {
      onPoint(false);
    },
    onFocus: () => {
      onPoint(true);
    },
    onBlur: () => {
      onPoint(false);
    },
  };
  if (onSelect)
    return (
      <button
        type="button"
        data-term={node.term}
        aria-pressed={selected}
        className={className}
        onClick={() => {
          onSelect(node);
        }}
        {...pointing}
      >
        {content}
      </button>
    );
  return (
    <span data-term={node.term} className={className} {...pointing}>
      {content}
    </span>
  );
}

/** The key: the standings the picture shows, and that the paler ideas are what it rests on. */
function Key({ map }: { map: TermMap }) {
  const present = (["owned", "settling", "coming"] as const).filter((s) =>
    map.nodes.some((n) => n.standing === s),
  );
  const ground = map.nodes.some((n) => !n.focus);
  return (
    <p className="mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-[11.5px] text-subtle-foreground">
      {present.map((standing) => (
        <span key={standing} className="flex items-center gap-1.5">
          <span aria-hidden className={cn("size-2.5 rounded-[2px] border", nodeClass[standing])} />
          {STANDING_LABEL[standing]}
        </span>
      ))}
      {ground && <span>Paler: what these rest on</span>}
    </p>
  );
}
