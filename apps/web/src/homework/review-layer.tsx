import type { ChecklistItem } from "@grounded/core/assignment";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { placeCards } from "@/lesson/aside-layout";
import { Connector, MarginCard } from "@/lesson/aside-layer";
import { ASIDE_UI, AsideSheet } from "@/lesson/aside-sheet";
import { findPassage, firstLine, highlightPassages, pointAt } from "@/lesson/passages";
import { cn } from "@/lib/utils";
import { fieldScope } from "./answer-view";
import { ReviewThread } from "./review-card";
import type { LiveComment } from "./use-review";

/** How far below a card's top its first line sits, where the connector meets it. */
const CARD_LINE = 21;
/** A card sits this far above its passage's first line, so their first lines align. */
const CARD_LIFT = 8;

interface Layout {
  margin: { left: number; width: number };
  tops: Record<string, number>;
  connector: { x1: number; y1: number; x2: number; y2: number } | null;
}

/** The words of the answer a comment is about, found again on the page; null for a whole field. */
function passageOf(answer: Element, comment: LiveComment): Range | null {
  const { taskId, field, quote, prefix, suffix } = comment.anchor;
  if (!quote) return null;
  return findPassage(answer, fieldScope(taskId, field), { blockId: "", quote, prefix, suffix });
}

export interface ReviewLayerProps {
  comments: readonly LiveComment[];
  checklist: readonly ChecklistItem[];
  active: string | null;
  onActivate: (commentId: string | null) => void;
  onReply: (commentId: string, text: string) => Promise<void>;
  grid: RefObject<HTMLElement | null>;
  answer: RefObject<HTMLElement | null>;
  margin: RefObject<HTMLElement | null>;
  /**
   * Cards in the margin beside their passages; otherwise under their fields (ReviewCards), the
   * open one in a sheet from the bottom.
   */
  wide: boolean;
  /** The label of the field a comment is on, for the sheet when it quotes nothing. */
  fieldLabel: (comment: LiveComment) => string;
}

/**
 * The review's comments beside the answer (design §7.4, §9.1): each passage marked as an aside's
 * is, the open comment's stronger and, in the margin, joined to its card by a dashed line; the
 * cards level with their passages, never overlapping (the aside layer's placement). A comment on a
 * field as a whole sits level with the field. Clicking a marked passage opens its comment.
 */
export function ReviewLayer(props: ReviewLayerProps) {
  const { comments, active, onActivate, wide, grid, answer, margin } = props;
  const [layout, setLayout] = useState<Layout | null>(null);

  useEffect(() => {
    const onPassage = (x: number, y: number) => {
      const root = answer.current;
      const point = pointAt(x, y);
      if (!root || !point) return null;
      return comments.find((c) => passageOf(root, c)?.isPointInRange(point.node, point.offset));
    };
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !answer.current?.contains(event.target)) return;
      if (!(window.getSelection()?.isCollapsed ?? true)) return;
      const hit = onPassage(event.clientX, event.clientY);
      if (!hit) return;
      onActivate(hit.id);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-aside-ui]")) return;
      if (onPassage(event.clientX, event.clientY)) return;
      onActivate(null);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [comments, answer, onActivate, wide]);

  // Measured after every change, and again whenever the page reflows or a card grows.
  const measure = useRef<() => void>(() => undefined);
  useLayoutEffect(() => {
    let unpaint: () => void = () => undefined;
    measure.current = () => {
      const root = answer.current;
      if (!grid.current || !root) return;
      const passages = comments.map((c) => ({ comment: c, range: passageOf(root, c) }));
      unpaint();
      unpaint = highlightPassages({
        quiet: passages.flatMap((p) => (p.range && p.comment.id !== active ? [p.range] : [])),
        active: passages.flatMap((p) => (p.range && p.comment.id === active ? [p.range] : [])),
      });
      if (!wide) return;
      const next = measureCards(grid.current, root, margin.current, passages, active);
      setLayout((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    };
    measure.current();
    return () => {
      unpaint();
    };
  });
  const cardIds = comments.map((c) => c.id).join(" ");
  useEffect(() => {
    const again = () => {
      measure.current();
    };
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
  }, [grid, cardIds, wide]);

  if (!wide) {
    const open = comments.find((c) => c.id === active);
    return open ? (
      <AsideSheet
        label="A comment on your answer"
        quote={open.anchor.quote || props.fieldLabel(open)}
        onClose={() => {
          onActivate(null);
        }}
      >
        <ReviewThread
          comment={open}
          items={props.checklist.filter((item) => open.items.includes(item.id))}
          expanded
          onReply={(text) => props.onReply(open.id, text)}
          onClose={() => {
            onActivate(null);
          }}
        />
      </AsideSheet>
    ) : null;
  }
  return (
    <div className="pointer-events-none absolute inset-0">
      {layout?.connector && <Connector {...layout.connector} />}
      <div
        className="absolute top-0 bottom-0"
        style={layout ? { left: layout.margin.left, width: layout.margin.width } : { right: 0 }}
      >
        {comments.map((comment) => (
          <MarginCard
            key={comment.id}
            id={comment.id}
            top={layout?.tops[comment.id]}
            active={comment.id === active}
            label="A comment on your answer"
            onActivate={() => {
              onActivate(comment.id);
            }}
          >
            <ReviewThread
              comment={comment}
              items={props.checklist.filter((item) => comment.items.includes(item.id))}
              expanded={comment.id === active}
              onReply={(text) => props.onReply(comment.id, text)}
              onClose={() => {
                onActivate(null);
              }}
            />
          </MarginCard>
        ))}
      </div>
    </div>
  );
}

/** Where the margin cards and the connector go. */
function measureCards(
  grid: HTMLElement,
  answer: HTMLElement,
  margin: HTMLElement | null,
  passages: readonly { comment: LiveComment; range: Range | null }[],
  active: string | null,
): Layout {
  const origin = grid.getBoundingClientRect();
  const column = answer.getBoundingClientRect();
  const marginRect = margin?.getBoundingClientRect();
  const fieldTop = (c: LiveComment) =>
    (answer
      .querySelector(`[data-step="${fieldScope(c.anchor.taskId, c.anchor.field)}"]`)
      ?.getBoundingClientRect().top ?? origin.top) - origin.top;
  const heights = new Map(
    [...grid.querySelectorAll<HTMLElement>("[data-aside-card]")].map((card) => [
      card.dataset.asideCard,
      card.offsetHeight,
    ]),
  );
  const lines = new Map(passages.map((p) => [p.comment.id, p.range ? firstLine(p.range) : null]));
  const tops = placeCards(
    passages.map(({ comment }) => {
      const line = lines.get(comment.id);
      return {
        id: comment.id,
        want: line ? line.top - origin.top - CARD_LIFT : fieldTop(comment),
        height: heights.get(comment.id) ?? 0,
      };
    }),
    active,
  );
  const marginLeft = (marginRect?.left ?? column.right) - origin.left;
  const line = active ? lines.get(active) : null;
  const top = active ? tops.get(active) : undefined;
  return {
    margin: { left: marginLeft, width: marginRect?.width ?? 300 },
    tops: Object.fromEntries(tops),
    connector:
      line && top !== undefined
        ? {
            x1: column.right - origin.left - 2,
            y1: line.top - origin.top + line.height / 2,
            x2: marginLeft,
            y2: top + CARD_LINE,
          }
        : null,
  };
}

/**
 * Where there is no margin (a phone, a narrow window): a field's comments in closed cards under it,
 * so none is missed. Tapping one, or its passage, opens it in the sheet (ReviewLayer).
 */
export function ReviewCards(props: {
  comments: readonly LiveComment[];
  checklist: readonly ChecklistItem[];
  active: string | null;
  onActivate: (commentId: string) => void;
  scope: string;
}) {
  const here = props.comments.filter(
    (c) => fieldScope(c.anchor.taskId, c.anchor.field) === props.scope,
  );
  if (here.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col gap-2.5">
      {here.map((comment) => {
        const active = comment.id === props.active;
        return (
          <button
            key={comment.id}
            type="button"
            {...ASIDE_UI}
            aria-label="Open this comment on your answer"
            onClick={() => {
              props.onActivate(comment.id);
            }}
            className={cn(
              "relative overflow-hidden rounded-lg border bg-card py-3 pr-3.5 pl-4 text-left font-sans text-card-foreground shadow-sm [--mark-surface:var(--card)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              active && "border-border-strong",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "absolute inset-y-0 left-0 w-[3px]",
                active ? "bg-primary" : "bg-primary/40",
              )}
            />
            <ReviewThread
              comment={comment}
              items={props.checklist.filter((item) => comment.items.includes(item.id))}
              expanded={false}
              onReply={() => Promise.resolve()}
            />
          </button>
        );
      })}
    </div>
  );
}
