import type { ReactNode } from "react";
import { cn } from "@/lib/format";

export function Section({
  title,
  note,
  children,
  className,
}: {
  title: string;
  /** What the figures mean, in a line. */
  note?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-lg border border-border bg-card p-4", className)}>
      <h2 className="text-sm font-semibold">{title}</h2>
      {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** One figure: the number large, what it counts beneath. */
export function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {detail && <div className="text-xs text-subtle-foreground">{detail}</div>}
    </div>
  );
}

/**
 * A row's share of a whole as a thin bar, its label and number beside it in text colours, so the
 * bar carries magnitude and the text carries everything else.
 */
export function ShareBar({
  label,
  value,
  of,
  display,
}: {
  label: ReactNode;
  value: number;
  of: number;
  display?: string;
}) {
  const width = of > 0 ? Math.max((value / of) * 100, value > 0 ? 1.5 : 0) : 0;
  return (
    <div className="grid grid-cols-[minmax(6rem,10rem)_1fr_auto] items-center gap-3 text-sm">
      <div className="truncate text-muted-foreground">{label}</div>
      <div
        className="h-2 rounded-full bg-muted"
        title={`${String(value)} of ${String(of)}`}
        role="presentation"
      >
        <div className="h-2 rounded-full bg-primary" style={{ width: `${String(width)}%` }} />
      </div>
      <div className="text-right tabular-nums">{display ?? String(value)}</div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-subtle-foreground">{children}</p>;
}

export const th = "px-2 py-1.5 text-left text-xs font-medium text-muted-foreground";
export const td = "px-2 py-1.5 align-top";
export const tdNum = "px-2 py-1.5 text-right align-top tabular-nums";

export function Loading() {
  return <p className="text-sm text-muted-foreground">Loading…</p>;
}

export function Failed({ error }: { error: Error }) {
  return <p className="text-sm text-destructive">Couldn't load: {error.message}</p>;
}
