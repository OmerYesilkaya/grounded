import { MessageSquarePlus, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useVisibleViewport } from "@/lib/visible-viewport";
import { QuotedPassage } from "./aside-card";

/** Marks the parts of the page that belong to asides: a tap outside them closes the card. */
export const ASIDE_UI = { "data-aside-ui": "" };

/** A drag down this far, or a flick, closes the sheet; less springs back. */
const CLOSE_DISTANCE = 96;
const CLOSE_SPEED = 0.6; // px per ms

/**
 * A card on a phone (design §9.4): a sheet from the bottom, over the lesson, with the passage it is
 * about. It stays above the on-screen keyboard, and dragging it down by its top closes it.
 */
export function AsideSheet(props: { quote: string; onClose: () => void; children: ReactNode }) {
  const viewport = useVisibleViewport();
  const drag = useDragDown(props.onClose);
  return (
    <div
      {...ASIDE_UI}
      role="dialog"
      aria-label="Question in the margin"
      style={{
        bottom: viewport.keyboard,
        // Room for the passage above it, whatever the keyboard leaves.
        maxHeight: `min(75dvh, ${String(viewport.height - 48)}px)`,
        translate: drag.offset ? `0 ${String(drag.offset)}px` : undefined,
      }}
      className={cn(
        "fixed inset-x-0 z-[45] flex flex-col rounded-t-xl border-t border-border-strong bg-card font-sans shadow-[0_-10px_40px_rgba(0,0,0,0.3)] [--mark-surface:var(--card)] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-8",
        !drag.dragging && "motion-safe:transition-[translate] motion-safe:duration-200",
      )}
    >
      {/* The sheet's top is its handle: the grab bar and the passage. */}
      <div
        {...drag.handlers}
        className="shrink-0 touch-none px-[max(1rem,env(safe-area-inset-left))] pt-2 select-none"
      >
        <div aria-hidden className="mx-auto mb-3 h-1 w-9 rounded-full bg-border-strong" />
        <div className="mb-3 flex items-start gap-3">
          <QuotedPassage quote={props.quote} className="flex-1" />
          <button
            type="button"
            aria-label="Close"
            onClick={props.onClose}
            className="touch-target relative -mt-1 -mr-1 rounded-full p-1.5 text-muted-foreground hover:bg-muted"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>
      <div className="min-h-0 overflow-y-auto overscroll-contain px-[max(1rem,env(safe-area-inset-left))] pb-[max(1rem,env(safe-area-inset-bottom))]">
        {props.children}
      </div>
    </div>
  );
}

/**
 * "Ask about this passage", on a phone: at the foot of the screen, clear of the phone's own menu
 * for the selection, which floats beside the selected text. A selection near the foot moves it to
 * the top, under the page's bar.
 */
export function AskButton(props: { range: Range; onAsk: () => void }) {
  const low = useNearFoot(props.range);
  return (
    <button
      type="button"
      {...ASIDE_UI}
      // Keep the selection: the button asks about it.
      onPointerDown={(event) => {
        event.preventDefault();
      }}
      onClick={props.onAsk}
      className={cn(
        "fixed left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border-strong bg-card px-4 py-2.5 font-sans text-[14px] font-medium whitespace-nowrap text-primary shadow-lg motion-safe:animate-in motion-safe:fade-in-0",
        low
          ? "top-[calc(3.25rem+0.75rem)] motion-safe:slide-in-from-top-2"
          : "bottom-[max(1.25rem,calc(env(safe-area-inset-bottom)+0.5rem))] motion-safe:slide-in-from-bottom-2",
      )}
    >
      <MessageSquarePlus className="size-4" aria-hidden />
      Ask about this passage
    </button>
  );
}

/** The selection reaches the bottom of the screen, where the button would sit. */
function useNearFoot(range: Range): boolean {
  const [low, setLow] = useState(false);
  useEffect(() => {
    const update = () => {
      const visible = window.visualViewport?.height ?? window.innerHeight;
      setLow(range.getBoundingClientRect().bottom > visible - 120);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    document.addEventListener("selectionchange", update);
    return () => {
      window.removeEventListener("scroll", update);
      document.removeEventListener("selectionchange", update);
    };
  }, [range]);
  return low;
}

/** Dragging the sheet down by its handle: how far, and closing it when let go far or fast enough. */
function useDragDown(onClose: () => void) {
  const start = useRef<{ id: number; y: number; at: number } | null>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const end = (event: PointerEvent, cancelled: boolean) => {
    const from = start.current;
    if (from?.id !== event.pointerId) return;
    start.current = null;
    setDragging(false);
    const distance = Math.max(0, event.clientY - from.y);
    const speed = distance / Math.max(1, event.timeStamp - from.at);
    if (!cancelled && (distance > CLOSE_DISTANCE || (distance > 16 && speed > CLOSE_SPEED)))
      onClose();
    else setOffset(0);
  };
  return {
    offset,
    dragging,
    handlers: {
      onPointerDown: (event: PointerEvent) => {
        // The close button is a button, not a handle.
        if (event.button !== 0 || (event.target as Element).closest("button")) return;
        start.current = { id: event.pointerId, y: event.clientY, at: event.timeStamp };
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove: (event: PointerEvent) => {
        const from = start.current;
        if (from?.id !== event.pointerId) return;
        setOffset(Math.max(0, event.clientY - from.y));
      },
      onPointerUp: (event: PointerEvent) => {
        end(event, false);
      },
      onPointerCancel: (event: PointerEvent) => {
        end(event, true);
      },
    },
  };
}
