import type { ReactNode } from "react";
import { cn } from "@/lib/format";

/** Model-written text as text: never rendered as HTML (design §12). */
export function Text({ children, mono }: { children: string; mono?: boolean }) {
  return (
    <div
      className={cn(
        "text-sm break-words whitespace-pre-wrap",
        mono && "font-mono text-xs leading-relaxed",
      )}
    >
      {children}
    </div>
  );
}

export function Fold({
  title,
  open,
  children,
}: {
  title: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={open} className="mt-2 group">
      <summary className="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">
        {title}
      </summary>
      <div className="mt-1 space-y-2">{children}</div>
    </details>
  );
}
