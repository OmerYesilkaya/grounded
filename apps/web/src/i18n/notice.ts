import type { Block } from "@grounded/content";
import { isNotice, type Notice } from "@grounded/core/notices";
import type { Messages } from ".";

/** What the API said: a notice, or words it stored before notices. */
export type Said = Notice | string;

/**
 * What the API said, in words (design §9.3): a notice worded in the app's language; words stored
 * before notices (a failure, an activity) as they are. A code this page doesn't know yet (an older
 * page, a newer API) says only that something didn't go through.
 */
export function wordNotice(said: Said, t: Messages): string {
  if (!isNotice(said)) return said;
  const words = (t.notices as Record<string, ((notice: Notice) => string) | undefined>)[said.code];
  return words ? words(said) : t.common.failed;
}

/** A failure said in a thread in place of the tutor's answer, as the blocks the thread shows. */
export const saidBlocks = (said: Said, t: Messages): Block[] => [
  { id: "failure", type: "paragraph", children: [{ type: "text", value: wordNotice(said, t) }] },
];
