import { useEffect, useState } from "react";

export interface VisibleViewport {
  /** How tall the part of the window the learner can see is. */
  height: number;
  /** How much of the page's foot the on-screen keyboard covers. */
  keyboard: number;
}

function visibleViewport(): VisibleViewport {
  const visual = window.visualViewport;
  // Zoomed in, the visible part is smaller for another reason: nothing is covered.
  if (!visual || visual.scale > 1.01) return { height: window.innerHeight, keyboard: 0 };
  const keyboard = Math.max(0, window.innerHeight - visual.height - visual.offsetTop);
  return { height: visual.height, keyboard: Math.round(keyboard) };
}

/**
 * The part of the window the learner can see, kept current, for what is fixed to the page's foot
 * (the chat's box, a question's sheet) to stay above the on-screen keyboard. iOS lays the keyboard
 * over the page without shrinking it; elsewhere (`interactive-widget=resizes-content`, index.html)
 * the page shrinks and the keyboard covers none of it.
 */
export function useVisibleViewport(): VisibleViewport {
  const [viewport, setViewport] = useState(visibleViewport);
  useEffect(() => {
    const visual = window.visualViewport;
    if (!visual) return;
    const update = () => {
      const next = visibleViewport();
      setViewport((was) =>
        was.height === next.height && was.keyboard === next.keyboard ? was : next,
      );
    };
    visual.addEventListener("resize", update);
    visual.addEventListener("scroll", update);
    return () => {
      visual.removeEventListener("resize", update);
      visual.removeEventListener("scroll", update);
    };
  }, []);
  return viewport;
}
