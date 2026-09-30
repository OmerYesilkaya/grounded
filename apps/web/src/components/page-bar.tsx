import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { Brand } from "./brand";
import { DrawerButton, useHasDrawer } from "./track-drawer";

/**
 * A page's header band, as tall as the track list's, so the two read as one (design §9.2): what
 * the page puts at its start, in its centre (kept centred whatever is beside it) and at its end.
 * On a phone it starts with the button that opens the track list (design §9.4), and the centre
 * follows the start, leaving the rest of a narrow bar to the end.
 */
export function PageBar(props: {
  start?: ReactNode;
  children?: ReactNode;
  end?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "sticky top-0 z-10 grid h-13 shrink-0 grid-cols-[auto_auto_1fr] items-center md:grid-cols-[1fr_auto_1fr] gap-2 border-b bg-background/90 pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] backdrop-blur",
        props.className,
      )}
    >
      <div className="flex min-w-0 items-center gap-1">
        <DrawerButton className="-ml-1.5" />
        {props.start}
      </div>
      <div className="flex min-w-0 items-center justify-center">{props.children}</div>
      <div className="flex min-w-0 items-center justify-end gap-2">{props.end}</div>
    </div>
  );
}

/**
 * The bar of a page that has none of its own: only on a phone, for the way to the track list (so
 * nothing, outside the app's shell).
 */
export function PhoneBar() {
  const t = useT();
  if (!useHasDrawer()) return null;
  return (
    <PageBar className="md:hidden">
      <Link to="/" aria-label={t.common.home}>
        <Brand className="text-base" />
      </Link>
    </PageBar>
  );
}
