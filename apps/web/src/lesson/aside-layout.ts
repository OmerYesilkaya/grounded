/** The space between two cards in the margin, in pixels. */
export const CARD_GAP = 10;

export interface CardSlot {
  id: string;
  /** Where the card would like its top: level with its passage. */
  want: number;
  height: number;
}

/**
 * Where each margin card goes (Google Docs behaviour): level with its passage where there is room,
 * never overlapping, in the order of the passages. The active card sits exactly by its passage; the
 * cards above it move up out of its way, the cards below it move down.
 */
export function placeCards(
  slots: readonly CardSlot[],
  activeId: string | null,
): Map<string, number> {
  const sorted = slots.toSorted((a, b) => a.want - b.want);
  const tops = sorted.map((slot) => slot.want);
  const top = (i: number) => tops[i] ?? 0;
  const height = (i: number) => sorted[i]?.height ?? 0;
  const pinned = sorted.findIndex((slot) => slot.id === activeId);
  for (let i = Math.max(pinned, 0) + 1; i < sorted.length; i++)
    tops[i] = Math.max(top(i), top(i - 1) + height(i - 1) + CARD_GAP);
  for (let i = pinned - 1; i >= 0; i--)
    tops[i] = Math.min(top(i), top(i + 1) - height(i) - CARD_GAP);
  return new Map(sorted.map((slot, i) => [slot.id, top(i)]));
}
