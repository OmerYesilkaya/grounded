import { useRouterState } from "@tanstack/react-router";
import { Menu, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { createContext, use, useState, type ReactNode } from "react";
import { useT } from "@/i18n";
import { useMediaQuery } from "@/lib/media-query";
import { cn } from "@/lib/utils";
import { TrackSidebar } from "./track-sidebar";

/** Where the track list is a column beside the page; below it, a drawer (design §9.4). */
export const SIDEBAR_SHOWN = "(min-width: 768px)";

const OpenDrawer = createContext<(() => void) | null>(null);

/**
 * The track list on a phone: a drawer from the left over the page, opened from the page's bar
 * (`DrawerButton`). Going anywhere closes it, and so does a tap outside it, Escape, or a window
 * grown wide enough for the column.
 */
export function TrackDrawer({ email, children }: { email: string; children: ReactNode }) {
  const href = useRouterState({ select: (state) => state.location.href });
  const column = useMediaQuery(SIDEBAR_SHOWN, true);
  const t = useT().sidebar;
  // The page it was opened on: on any other, it is closed.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === href && !column;
  const close = () => {
    setOpenOn(null);
  };

  return (
    <OpenDrawer
      value={() => {
        setOpenOn(href);
      }}
    >
      {children}
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          setOpenOn(next ? href : null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
          <Dialog.Content
            aria-describedby={undefined}
            // A link followed to the page already shown changes nothing to close on: close anyway.
            onClickCapture={(event) => {
              if (event.target instanceof Element && event.target.closest("a[href]")) close();
            }}
            className="fixed inset-y-0 left-0 z-50 flex w-[min(304px,calc(100vw-48px))] shadow-[8px_0_40px_rgba(0,0,0,0.35)] outline-none data-[state=closed]:animate-out data-[state=closed]:duration-200 data-[state=closed]:slide-out-to-left data-[state=open]:animate-in data-[state=open]:duration-250 data-[state=open]:slide-in-from-left motion-reduce:animate-none"
          >
            <Dialog.Title className="sr-only">{t.tracks}</Dialog.Title>
            <TrackSidebar
              email={email}
              className="h-full w-full"
              headerEnd={
                <Dialog.Close
                  aria-label={t.closeList}
                  className="touch-target relative -mr-1.5 ml-auto flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <X className="size-4.5" />
                </Dialog.Close>
              }
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </OpenDrawer>
  );
}

/** Whether the page is inside the app's shell, where there is a track list to open. */
export const useHasDrawer = () => use(OpenDrawer) !== null;

/** Opens the track list's drawer; only where the list isn't a column already. */
export function DrawerButton({ className }: { className?: string }) {
  const open = use(OpenDrawer);
  const t = useT().sidebar;
  if (!open) return null;
  return (
    <button
      type="button"
      aria-label={t.openList}
      aria-haspopup="dialog"
      onClick={open}
      className={cn(
        "touch-target relative flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 md:hidden",
        className,
      )}
    >
      <Menu className="size-5" />
    </button>
  );
}
