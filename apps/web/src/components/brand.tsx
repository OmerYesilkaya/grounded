import { LayerArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The product's mark and wordmark, in the accent colour. Both scale with the font size it is given,
 * so one class sets how large the brand reads. The same mark is the favicon (`public/favicon.svg`).
 */
export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-[0.4em] font-brand text-primary", className)}>
      <LayerArrowUp aria-hidden className="size-[1.35em] shrink-0" />
      {/* Notable's glyphs sit low on their line box; lift them to centre on the mark. */}
      <span className="mb-[0.2em] leading-none">Grounded</span>
    </span>
  );
}
