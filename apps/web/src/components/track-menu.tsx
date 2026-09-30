import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Ellipsis, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/i18n";
import { api, ApiError } from "@/lib/api";
import type { TrackSummary } from "@/lib/tracks";

/**
 * A track's menu at the end of its line in the track list (design §9.2): shown while the line is
 * hovered or focused, and always on a touch screen, which has no hover. Deleting asks first, naming
 * what goes with the track.
 */
export function TrackMenu({ track, current }: { track: TrackSummary; current: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const { sidebar, common } = useT();
  const t = sidebar.menu;
  const remove = useMutation({
    mutationFn: () => api<undefined>(`/api/tracks/${track.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setConfirming(false);
      queryClient.setQueryData<TrackSummary[]>(["tracks"], (all) =>
        all?.filter((t) => t.id !== track.id),
      );
      for (const item of track.items) queryClient.removeQueries({ queryKey: ["session", item.id] });
      // Off a page that showed it: home opens the next track, or a new one.
      if (current) await navigate({ to: "/" });
      await queryClient.invalidateQueries({ queryKey: ["tracks"] });
    },
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t.more(track.title)}
          className="touch-target relative mr-0.5 hidden size-6 shrink-0 items-center pointer-coarse:flex pointer-coarse:size-8 justify-center rounded-[4px] text-subtle-foreground outline-none group-focus-within/track:flex group-hover/track:flex hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:flex data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          <Ellipsis className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right" className="w-44">
          <DropdownMenuItem
            onSelect={() => {
              remove.reset();
              setConfirming(true);
            }}
            className="text-destructive focus:text-destructive [&_svg:not([class*='text-'])]:text-destructive"
          >
            <Trash2 />
            {t.delete}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!remove.isPending) setConfirming(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>{t.confirm(track.title)}</AlertDialogTitle>
          <AlertDialogDescription>{t.whatGoes}</AlertDialogDescription>
          {remove.error && (
            <p className="mt-3 text-sm text-destructive">
              {remove.error instanceof ApiError ? remove.error.message : common.failed}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialogCancel asChild>
              <Button variant="ghost" size="sm" disabled={remove.isPending}>
                {t.keep}
              </Button>
            </AlertDialogCancel>
            <Button
              variant="destructive"
              size="sm"
              disabled={remove.isPending}
              onClick={() => {
                remove.mutate();
              }}
            >
              {remove.isPending ? t.deleting : t.deleteTrack}
            </Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
