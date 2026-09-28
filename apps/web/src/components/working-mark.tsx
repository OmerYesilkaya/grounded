import type { AnimationItem } from "lottie-web";
import { useEffect, useRef } from "react";
import { prefersReducedMotion, usePrefersReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The small animated mark beside a label for work in progress: layers stacking up, again and again
 * while it shows, a little slower than drawn and with a rest between passes so it stays quiet. Its outlines take the text colour and its faces the surface behind it (`--mark-surface`,
 * the page background unless a container sets it), so it reads in both themes; the outlines are as
 * thick as a lucide icon's at the same size. The player and the animation load on first use, off the
 * main bundle. Under reduced motion it holds its first frame.
 */
/** Playback rate: 1 is the animation as drawn, one pass in 0.6 s. */
const SPEED = 0.75;
/** How long the mark rests, on the frame a pass ends on, before the next pass. */
const REST_MS = 800;

export function WorkingMark({ className }: { className?: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const animation = useRef<AnimationItem | null>(null);
  const still = usePrefersReducedMotion();

  useEffect(() => {
    const container = box.current;
    if (!container) return;
    let cancelled = false;
    let rest: ReturnType<typeof setTimeout> | undefined;

    void Promise.all([
      import("lottie-web/build/player/lottie_light"),
      import("@/assets/layers.json"),
    ]).then(([{ default: lottie }, { default: animationData }]) => {
      if (cancelled) return;
      const item = lottie.loadAnimation({
        container,
        renderer: "svg",
        loop: false,
        autoplay: !prefersReducedMotion(),
        animationData,
        // The layers only ever move within the middle third of the 256-unit canvas: crop to that
        // square (plus half a stroke), so the mark fills the box it is given.
        rendererSettings: { viewBoxSize: "84 84 88 88" },
      });
      item.setSpeed(SPEED);
      item.addEventListener("complete", () => {
        rest = setTimeout(() => {
          if (!prefersReducedMotion()) item.goToAndPlay(0, true);
        }, REST_MS);
      });
      animation.current = item;
    });

    return () => {
      cancelled = true;
      clearTimeout(rest);
      animation.current?.destroy();
      animation.current = null;
    };
  }, []);

  useEffect(() => {
    // A restart pending when motion is reduced sees it and stays put; motion allowed again, the mark
    // starts a fresh pass, since a finished pass has nothing left to play.
    if (still) animation.current?.goToAndStop(0, true);
    else animation.current?.goToAndPlay(0, true);
  }, [still]);

  return (
    <span
      ref={box}
      aria-hidden
      className={cn(
        "inline-block size-4 shrink-0 [&_path[fill]]:fill-(--mark-surface,var(--background)) [&_path[stroke]]:stroke-current [&_path[stroke]]:stroke-7",
        className,
      )}
    />
  );
}
