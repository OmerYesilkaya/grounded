/*
 * Where an aside hangs (design §7.5), shared by the web, which makes anchors from what the learner
 * selects, and the API, which keeps them. No dependencies, so the web can import it on its own.
 */

/** How long a selected passage, the text around it and a question may be. */
export const ASIDE_LIMITS = { quote: 2000, context: 64, question: 2000 } as const;

/**
 * Where an aside hangs: the block the passage is in and the passage as quoted, with a little of the
 * text before and after it. A card finds its passage again by the quote (the text around it picks
 * the right one when the quote appears twice), so it survives what is added nearby: a note under a
 * check is its own block, and the lesson's blocks keep their ids.
 */
export interface AsideAnchor {
  /** The block the passage starts in (`s2.b3`); its step is the part before the dot. */
  blockId: string;
  quote: string;
  /** Up to ASIDE_LIMITS.context characters of the lesson's text just before the quote. */
  prefix: string;
  /** Up to ASIDE_LIMITS.context characters just after it. */
  suffix: string;
}

/** The step a block belongs to: `s2` for `s2.b3`. */
export const stepOfBlock = (blockId: string) => blockId.split(".")[0] ?? blockId;
