import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { scrollBehavior } from "./motion";

/** A reader this close to the end of the page, in pixels, counts as at the bottom. */
const NEAR_BOTTOM_PX = 48;

export interface StickToBottom {
  /** The reader is at the bottom, and the page keeps them there as it grows. */
  following: boolean;
  /** Goes to the bottom and follows again; `smooth` glides there unless motion is reduced. */
  scrollToBottom: (options?: { smooth?: boolean }) => void;
}

function distanceFromBottom(): number {
  return document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
}

/**
 * Keeps the window scrolled to the end of the page while the reader is at (or near) it, like a
 * chat: whenever `content` or `overlay` (a fixed bar over the bottom, whose height the page's
 * bottom padding follows) changes size, the page scrolls to its end. A reader who scrolls up away
 * from the end is left where they are until they come back down or call `scrollToBottom`.
 */
export function useStickToBottom({
  content,
  overlay = null,
}: {
  content: HTMLElement | null;
  overlay?: HTMLElement | null;
}): StickToBottom {
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const follow = useCallback((next: boolean) => {
    followingRef.current = next;
    setFollowing(next);
  }, []);

  useEffect(() => {
    let lastY = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      if (distanceFromBottom() <= NEAR_BOTTOM_PX) follow(true);
      // Only moving up lets go: the page's own scrolls and a glide to the bottom go down.
      else if (y < lastY) follow(false);
      lastY = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
    };
  }, [follow]);

  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    // Called once on observe, then on every change: the reveal, late-rendering blocks, the bar.
    const observer = new ResizeObserver(() => {
      if (!followingRef.current) return;
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
    });
    for (const element of [content, overlay]) {
      if (element) observer.observe(element, { box: "border-box" });
    }
    return () => {
      observer.disconnect();
    };
  }, [content, overlay]);

  const scrollToBottom = useCallback(
    ({ smooth = false }: { smooth?: boolean } = {}) => {
      follow(true);
      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: smooth ? scrollBehavior() : "instant",
      });
    },
    [follow],
  );

  return { following, scrollToBottom };
}
