import type { Block } from "@grounded/content";
import { ArrowUpRight, Sparkle } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "@/i18n";

/**
 * A word card (design §6.2): the moment a word is given, set apart from the prose so it can't be
 * read past. The accent border and star mark it as the lesson's own; the word, then what it means.
 */
export function WordCardView({
  block,
  children,
}: {
  block: Extract<Block, { type: "word" }>;
  children: ReactNode;
}) {
  const t = useT().lesson.blocks;
  return (
    <aside
      data-block={block.id}
      aria-label={t.newWordLabel(block.term)}
      className="my-6 rounded-md border border-primary/60 bg-primary/[0.06] px-5 py-4"
    >
      <p className="mb-1 flex items-center gap-1.5 font-sans text-[11px] font-semibold tracking-[0.08em] text-primary uppercase">
        <Sparkle aria-hidden className="size-3.5 fill-current" />
        {t.newWord}
      </p>
      <p className="mb-2 font-serif text-xl font-semibold tracking-tight">{block.term}</p>
      <div className="[&>*:last-child]:mb-0">{children}</div>
    </aside>
  );
}

/** Where "Make a track about this" goes: a new track with the card's goal already in the box. */
export const newTrackHref = (goal: string) => `/tracks/new?goal=${encodeURIComponent(goal)}`;

/**
 * A preview of a person, place or work the lesson leans on (design §6.2): a paragraph at most.
 * When there is more to it, the card offers a track of its own, opened in a new tab so the lesson
 * stays where it is.
 */
export function AboutCardView({
  block,
  children,
}: {
  block: Extract<Block, { type: "about" }>;
  children: ReactNode;
}) {
  const t = useT().lesson.blocks;
  return (
    <aside
      data-block={block.id}
      aria-label={t.about(block.name)}
      className="my-6 rounded-md border border-border-strong bg-card px-5 py-4"
    >
      <p className="mb-2 font-serif text-lg font-semibold tracking-tight">{block.name}</p>
      <div className="[&>*:last-child]:mb-0">{children}</div>
      {block.track && (
        <a
          href={newTrackHref(block.track)}
          target="_blank"
          rel="noopener"
          className="mt-3 inline-flex items-center gap-1 font-sans text-[13px] font-medium text-primary hover:underline"
        >
          {t.makeTrack}
          <ArrowUpRight aria-hidden className="size-3.5" />
        </a>
      )}
    </aside>
  );
}
