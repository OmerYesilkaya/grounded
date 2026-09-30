import type { Snooze } from "@grounded/core/snooze";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { LaterMenu } from "@/homework/later-menu";
import { useT } from "@/i18n";
import { assignmentApi } from "@/lib/assignments";
import { useNow } from "@/lib/snooze";
import { isDue, useTracks, type AssignedItem } from "@/lib/tracks";

/** A reminder dismissed in this tab stays dismissed until the homework is put off again. */
const DISMISSED_KEY = "grounded:reminders-dismissed";
const reminderKey = (item: AssignedItem) => `${item.id}@${String(item.due)}`;

function dismissed(): string[] {
  try {
    const stored = JSON.parse(sessionStorage.getItem(DISMISSED_KEY) ?? "[]") as unknown;
    return Array.isArray(stored) ? stored.filter((key) => typeof key === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The reminder on the next visit (design §7.4, in-app in v1): homework or an arc exam put off whose
 * time has come, in a card at the foot of the page until the learner opens it, puts it off again or
 * dismisses it for this visit. Not on its own page.
 */
export function HomeworkReminder() {
  const tracks = useTracks();
  const params = useParams({ strict: false });
  const now = useNow();
  const queryClient = useQueryClient();
  const [hidden, setHidden] = useState(dismissed);
  const t = useT().homework;
  const later = useMutation({
    mutationFn: ({ id, snooze }: { id: string; snooze: Snooze }) => assignmentApi.later(id, snooze),
    onSuccess: async (_, { id }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tracks"] }),
        queryClient.invalidateQueries({ queryKey: ["assignment", id] }),
      ]);
    },
  });

  const due = (tracks.data ?? []).flatMap((track) =>
    track.items.filter((item) => isDue(item, now)).map((item) => ({ item, track: track.title })),
  );
  const shown = due.filter(
    ({ item }) => item.id !== params.assignmentId && !hidden.includes(reminderKey(item)),
  );
  const [first] = shown;
  if (!first) return null;
  const { item, track } = first;
  const what = item.kind === "exam" ? t.due.exam : t.due.homework;

  const dismiss = () => {
    const next = [...hidden, ...shown.map(({ item: i }) => reminderKey(i))];
    setHidden(next);
    try {
      sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
    } catch {
      // Kept for this page only.
    }
  };

  return (
    <aside
      aria-label={what}
      className="fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] left-[max(1rem,env(safe-area-inset-left))] z-40 rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg sm:left-auto sm:w-[360px]"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold tracking-[0.14em] text-primary uppercase">
            {what}
          </p>
          <p className="mt-1 font-serif text-[16px] leading-snug font-semibold">{item.title}</p>
          <p className="mt-0.5 text-[12.5px] text-subtle-foreground">
            {t.reminderWhere(track, item.session)}
            {shown.length > 1 && t.moreDue(shown.length - 1)}
          </p>
        </div>
        <button
          type="button"
          aria-label={t.notNow}
          onClick={dismiss}
          className="touch-target relative -mt-1 -mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-subtle-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button asChild size="sm">
          <Link to="/homework/$assignmentId" params={{ assignmentId: item.id }}>
            {t.openIt}
          </Link>
        </Button>
        <LaterMenu
          size="sm"
          disabled={later.isPending}
          onChoose={(snooze) => {
            later.mutate({ id: item.id, snooze });
          }}
        />
      </div>
      {later.error && (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {later.error.message}
        </p>
      )}
    </aside>
  );
}
