import { MessageSquarePlus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { LearnerText } from "@/content/learner-text";
import { useT } from "@/i18n";
import { isTouchScreen } from "@/lib/media-query";
import { cn } from "@/lib/utils";
import { AskDraft, AsideThread, QuotedPassage, Thinking } from "./aside-card";
import { ASIDE_UI, AskButton, AsideSheet } from "./aside-sheet";
import { HintCard } from "./aside-hint";
import { placeCards, type CardSlot } from "./aside-layout";
import {
  anchorOf,
  findPassage,
  firstLine,
  highlightPassages,
  pointAt,
  type Selected,
} from "./passages";
import type { Aside, LessonAsides } from "./types";

/** The draft of a first question, on a passage selected a moment ago. */
interface Draft extends Selected {
  /** The question, once sent: its card is on its way. */
  sent?: { id: string; question: string };
}

interface Layout {
  /** The margin column, from the lesson grid's left. */
  margin: { left: number; width: number };
  /** The reading column, from the grid's left. */
  column: { left: number; width: number };
  tops: Record<string, number>;
  /** Cards whose passage can't be found any more (they show the quote themselves). */
  detached: string[];
  /** Where the "Ask about this" button goes, level with the selection. */
  ask: number | null;
  /** The dashed line from the active passage to its card. */
  connector: { x1: number; y1: number; x2: number; y2: number } | null;
}

const DRAFT = "draft";
/** How far below a card's top its first line sits, where the connector meets it. */
const CARD_LINE = 21;
/** A card sits this far above its passage's first line, so their first lines align. */
const CARD_LIFT = 8;

export interface AsideLayerProps extends LessonAsides {
  grid: RefObject<HTMLElement | null>;
  lesson: RefObject<HTMLElement | null>;
  margin: RefObject<HTMLElement | null>;
  /** Cards in the margin beside their passages; otherwise a sheet from the bottom (phones). */
  wide: boolean;
}

/**
 * Asides on the lesson page (design §7.5, §9.1): select a passage and ask; the card appears in the
 * margin beside it and streams at once, follow-ups inside it. On a narrow screen the margin is gone,
 * so asking starts from a button at the bottom and a card opens as a sheet; tapping a marked passage
 * opens its card again. Passages are marked with highlights, the active one stronger and joined to
 * its card by a dashed line.
 */
export function AsideLayer(props: AsideLayerProps) {
  const { items, canAsk, wide, lesson, grid, margin } = props;
  const t = useT().lesson.asides;
  const [active, setActive] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sheet, setSheet] = useState(false);
  const [selected, clearSelected] = useLessonSelection(lesson, canAsk);
  const [layout, setLayout] = useState<Layout | null>(null);

  // A sent question's card has arrived: it takes the draft's place, open.
  if (draft?.sent && items.some((a) => a.id === draft.sent?.id)) {
    setActive(draft.sent.id);
    setDraft(null);
  }

  const close = useCallback(() => {
    setActive(null);
    setSheet(false);
  }, []);

  const openDraft = (selection: Selected) => {
    // The passage stays marked by its highlight. The page's own selection, or a check's answer box
    // holding focus, would keep the question box from taking it.
    window.getSelection()?.removeAllRanges();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    clearSelected();
    setDraft(selection);
    setActive(null);
    setSheet(true);
  };

  const ask = async (text: string) => {
    if (!draft) return;
    const id = await props.onAsk(draft.anchor, text);
    setDraft((current) => (current ? { ...current, sent: { id, question: text } } : current));
  };

  // Clicking a marked passage opens its card; a click anywhere else outside the cards closes it.
  useEffect(() => {
    const onPassage = (x: number, y: number) => {
      const root = lesson.current;
      const point = pointAt(x, y);
      if (!root || !point) return null;
      return (
        items.find((aside) =>
          findPassage(root, aside.stepId, aside.anchor)?.isPointInRange(point.node, point.offset),
        ) ?? null
      );
    };
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !lesson.current?.contains(event.target)) return;
      // The end of selecting a passage is not a click on one.
      if (!(window.getSelection()?.isCollapsed ?? true)) return;
      const hit = onPassage(event.clientX, event.clientY);
      if (!hit) return;
      setActive(hit.id);
      setSheet(true);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-aside-ui]")) return;
      if (onPassage(event.clientX, event.clientY)) return;
      close();
      // On a phone the sheet closes with its question; in the margin, a draft stays until it is
      // sent or cancelled.
      if (!wide) setDraft(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      setDraft(null);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [items, lesson, close, wide]);

  // Where everything goes, measured from the page after every change, and again whenever the page
  // reflows (a diagram renders, a note arrives, the window narrows) or a card grows as it streams.
  const measure = useRef<() => void>(() => undefined);
  useLayoutEffect(() => {
    let unpaint: () => void = () => undefined;
    measure.current = () => {
      const measured = measureLayout({
        grid: grid.current,
        lesson: lesson.current,
        margin: margin.current,
        items,
        draft,
        active,
        selected: draft?.sent ? null : selected,
      });
      if (!measured) return;
      unpaint();
      unpaint = highlightPassages(measured.highlights);
      const next = measured.layout;
      setLayout((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    };
    measure.current();
    return () => {
      unpaint();
    };
  });
  const cardIds = [...items.map((a) => a.id), ...(draft ? [DRAFT] : [])].join(" ");
  useEffect(() => {
    const again = () => {
      measure.current();
    };
    // Neither exists where nothing is laid out (tests).
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(again);
    if (grid.current) observer?.observe(grid.current);
    for (const card of grid.current?.querySelectorAll("[data-aside-card]") ?? [])
      observer?.observe(card);
    window.addEventListener("resize", again);
    if ("fonts" in document) void document.fonts.ready.then(again);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", again);
    };
  }, [grid, cardIds]);

  const threadProps = (aside: Aside, expanded: boolean) => ({
    aside,
    expanded,
    canAsk,
    onFollowUp: (text: string) => props.onFollowUp(aside.id, text),
    onSave: () => {
      props.onSave(aside.id);
    },
    onClose: close,
  });

  const showHint = props.hint && canAsk && items.length === 0 && !draft;
  const activeAside = items.find((a) => a.id === active) ?? null;
  const draftBody = draft?.sent ? (
    <SentQuestion question={draft.sent.question} />
  ) : (
    <AskDraft
      onSubmit={ask}
      onCancel={() => {
        setDraft(null);
        setSheet(false);
      }}
    />
  );

  if (!wide) {
    return (
      <>
        {showHint && layout && (
          <p
            className="absolute top-3 flex items-center gap-1.5 truncate px-2 font-sans text-[12.5px] text-subtle-foreground"
            style={{ left: layout.column.left, width: layout.column.width }}
          >
            <MessageSquarePlus className="size-3.5" aria-hidden />
            {/* On a touch screen, holding a passage is what selects it. */}
            {isTouchScreen() ? t.holdToAsk : t.selectToAsk}
          </p>
        )}
        {selected && !draft && !sheet && (
          <AskButton
            range={selected.range}
            onAsk={() => {
              openDraft(selected);
            }}
          />
        )}
        {sheet && (draft ?? activeAside) && (
          <AsideSheet
            label={t.sheet}
            quote={draft?.anchor.quote ?? activeAside?.anchor.quote ?? ""}
            onClose={() => {
              close();
              setDraft(null);
            }}
          >
            {draft ? draftBody : activeAside && <AsideThread {...threadProps(activeAside, true)} />}
          </AsideSheet>
        )}
      </>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0">
      {layout?.connector && <Connector {...layout.connector} />}
      <div
        className="absolute top-0 bottom-0"
        style={layout ? { left: layout.margin.left, width: layout.margin.width } : { right: 0 }}
      >
        {showHint && <HintCard />}
        {layout?.ask != null && selected && !draft?.sent && (
          <button
            type="button"
            {...ASIDE_UI}
            // Keep the selection: the button asks about it.
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              openDraft(selected);
            }}
            style={{ top: layout.ask }}
            className="pointer-events-auto absolute left-0 z-20 flex items-center gap-1.5 rounded-md border border-border-strong bg-card px-2.5 py-1.5 font-sans text-[12.5px] font-medium text-primary shadow-md transition-colors hover:bg-highlight motion-safe:animate-in motion-safe:fade-in-0"
          >
            <MessageSquarePlus className="size-3.5" aria-hidden />
            {t.askAboutThis}
          </button>
        )}
        {items.map((aside) => {
          const isActive = aside.id === active;
          return (
            <MarginCard
              key={aside.id}
              id={aside.id}
              top={layout?.tops[aside.id]}
              active={isActive}
              label={t.questionOn(short(aside.anchor.quote))}
              onActivate={() => {
                setActive(aside.id);
              }}
            >
              {layout?.detached.includes(aside.id) && (
                <QuotedPassage quote={aside.anchor.quote} className="mb-2" />
              )}
              <AsideThread {...threadProps(aside, isActive)} />
            </MarginCard>
          );
        })}
        {draft && (
          <MarginCard id={DRAFT} top={layout?.tops[DRAFT]} active label={t.yourQuestion}>
            {draftBody}
          </MarginCard>
        )}
      </div>
    </div>
  );
}

/** Where the cards, the ask button and the connector go, and which passages to mark. */
function measureLayout(input: {
  grid: HTMLElement | null;
  lesson: HTMLElement | null;
  margin: HTMLElement | null;
  items: readonly Aside[];
  draft: Draft | null;
  active: string | null;
  selected: Selected | null;
}): { layout: Layout; highlights: { quiet: Range[]; active: Range[] } } | null {
  const { grid, lesson, items, draft, active, selected } = input;
  if (!grid || !lesson) return null;
  const origin = grid.getBoundingClientRect();
  const column = lesson.getBoundingClientRect();
  const marginRect = input.margin?.getBoundingClientRect();
  const focus = active ?? (draft ? DRAFT : null);
  const passages = [
    ...items.map((aside) => ({
      id: aside.id,
      stepId: aside.stepId,
      range: findPassage(lesson, aside.stepId, aside.anchor),
    })),
    ...(draft ? [{ id: DRAFT, stepId: draft.stepId, range: draft.range }] : []),
  ];
  const lineOf = (range: Range | null) => (range ? firstLine(range) : null);
  const stepTop = (stepId: string) =>
    (lesson.querySelector(`[data-step="${stepId}"]`)?.getBoundingClientRect().top ?? origin.top) -
    origin.top;
  const heights = new Map(
    [...grid.querySelectorAll<HTMLElement>("[data-aside-card]")].map((card) => [
      card.dataset.asideCard,
      card.offsetHeight,
    ]),
  );
  const slots: CardSlot[] = passages.map((p) => {
    const line = lineOf(p.range);
    return {
      id: p.id,
      want: line ? line.top - origin.top - CARD_LIFT : stepTop(p.stepId),
      height: heights.get(p.id) ?? 0,
    };
  });
  const tops = placeCards(slots, focus);
  const focusLine = lineOf(passages.find((p) => p.id === focus)?.range ?? null);
  const focusTop = focus === null ? undefined : tops.get(focus);
  const marginLeft = (marginRect?.left ?? column.right) - origin.left;
  const askLine = selected ? lineOf(selected.range) : null;
  return {
    highlights: {
      quiet: passages.flatMap((p) => (p.range && p.id !== focus ? [p.range] : [])),
      active: passages.flatMap((p) => (p.range && p.id === focus ? [p.range] : [])),
    },
    layout: {
      margin: { left: marginLeft, width: marginRect?.width ?? 300 },
      column: { left: column.left - origin.left, width: column.width },
      tops: Object.fromEntries(tops),
      detached: passages.filter((p) => !p.range).map((p) => p.id),
      // Where the browser lays out no lines (tests), at the top.
      ask: selected ? (askLine ? askLine.top - origin.top - 4 : 0) : null,
      connector:
        focusLine && focusTop !== undefined
          ? {
              // From just past the reading column's text, level with the passage's first line.
              x1: column.right - origin.left - 2,
              y1: focusLine.top - origin.top + focusLine.height / 2,
              x2: marginLeft,
              y2: focusTop + CARD_LINE,
            }
          : null,
    },
  };
}

/** A card in the margin: a thin accent strip, lifted a little on hover, raised when active. */
export function MarginCard({
  id,
  top,
  active,
  label,
  onActivate,
  children,
}: {
  id: string;
  top: number | undefined;
  active: boolean;
  label: string;
  onActivate?: () => void;
  children: ReactNode;
}) {
  return (
    <div
      {...ASIDE_UI}
      data-aside-card={id}
      role="group"
      aria-label={label}
      tabIndex={active || !onActivate ? undefined : 0}
      onClick={active ? undefined : onActivate}
      onKeyDown={(event) => {
        if (!active && onActivate && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onActivate();
        }
      }}
      // Unseen until measured, so it never shows in the wrong place (but can take focus).
      style={{ top: top ?? 0, opacity: top === undefined ? 0 : undefined }}
      className={cn(
        "pointer-events-auto absolute inset-x-0 overflow-hidden rounded-lg border bg-card py-3 pr-3.5 pl-4 font-sans text-card-foreground [--mark-surface:var(--card)] motion-safe:transition-[translate,box-shadow] motion-safe:duration-200",
        active
          ? "z-10 border-border-strong shadow-[0_6px_24px_rgba(0,0,0,0.22)]"
          : "cursor-pointer shadow-sm hover:-translate-y-px hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
      )}
    >
      <span
        aria-hidden
        className={cn("absolute inset-y-0 left-0 w-[3px]", active ? "bg-primary" : "bg-primary/40")}
      />
      {children}
    </div>
  );
}

/** The dashed line from the active passage to its card, through the gap between them. */
export function Connector({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  const bend = x1 + (x2 - x1) / 2;
  return (
    <svg aria-hidden className="absolute inset-0 h-full w-full overflow-visible text-primary">
      <circle cx={x1} cy={y1} r={2.5} fill="currentColor" />
      <path
        d={`M ${String(x1)} ${String(y1)} H ${String(bend)} V ${String(y2)} H ${String(x2)}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeDasharray="3 3"
        opacity={0.75}
      />
    </svg>
  );
}

/** A question on its way, while its card is being made. */
function SentQuestion({ question }: { question: string }) {
  return (
    <div>
      <p className="mb-1.5 text-[13px] leading-snug font-medium whitespace-pre-wrap text-foreground">
        <LearnerText text={question} />
      </p>
      <Thinking />
    </div>
  );
}

const short = (quote: string) => (quote.length > 40 ? `${quote.slice(0, 40).trimEnd()}…` : quote);

/**
 * The passage the learner has selected in the lesson, ready to ask about; null when there is none
 * (or asking is off). On a touch screen a tap can clear the selection before it lands, so the
 * passage is let go a moment after the page's selection.
 */
function useLessonSelection(
  lesson: RefObject<HTMLElement | null>,
  enabled: boolean,
): [Selected | null, () => void] {
  const [selected, setSelected] = useState<Selected | null>(null);
  const clear = useCallback(() => {
    setSelected(null);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let release: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => {
      const selection = window.getSelection();
      const root = lesson.current;
      const found =
        root && selection && selection.rangeCount > 0 && !selection.isCollapsed
          ? anchorOf(root, selection.getRangeAt(0))
          : null;
      clearTimeout(release);
      if (found) setSelected(found);
      else
        release = setTimeout(() => {
          setSelected(null);
        }, 300);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      clearTimeout(release);
      document.removeEventListener("selectionchange", onChange);
    };
  }, [lesson, enabled]);
  return [enabled ? selected : null, clear];
}
