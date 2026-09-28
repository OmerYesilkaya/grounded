import { MessageSquarePlus } from "lucide-react";

/**
 * Until the learner's first question, the empty margin shows how to ask (design §9.1): a faint card
 * with a tiny page in which a passage is selected and asked about, over and over. Under reduced
 * motion the tiny page holds the selection.
 */
export function HintCard() {
  return (
    <div className="sticky top-24 mt-10 rounded-lg border border-dashed border-border-strong px-4 py-3.5 font-sans opacity-80">
      <div aria-hidden className="mb-3 flex flex-col gap-[7px]">
        <span className="h-[5px] w-full rounded-full bg-border-strong" />
        <span className="flex items-center gap-1.5">
          <span className="h-[5px] w-[22%] rounded-full bg-border-strong" />
          <span className="relative h-[9px] w-[38%]">
            <span className="absolute inset-x-0 top-[2px] h-[5px] rounded-full bg-border-strong" />
            <span className="absolute inset-0 origin-left rounded-[2px] bg-primary/35 motion-safe:animate-hint-select" />
          </span>
          <span className="h-[5px] w-[18%] rounded-full bg-border-strong" />
          <span className="ml-auto flex items-center gap-1 rounded-[3px] border border-border-strong bg-card px-1.5 py-px text-[9.5px] font-medium text-primary motion-safe:animate-hint-ask">
            <MessageSquarePlus className="size-2.5" />
            Ask
          </span>
        </span>
        <span className="h-[5px] w-[64%] rounded-full bg-border-strong" />
      </div>
      <p className="text-[12.5px] leading-relaxed text-subtle-foreground">
        Stuck on a word or a step? Select any passage and ask about it. The answer appears here,
        beside it.
      </p>
    </div>
  );
}
