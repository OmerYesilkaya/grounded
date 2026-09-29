import { parseBlocks } from "@grounded/content";
import { Fragment, useMemo } from "react";
import { Inlines } from "./inlines";

/**
 * What the learner wrote in the one-line editor (a check answer, a question in the margin): its
 * `code`, **bold** and `$…$` maths shown as such, its line breaks kept (put it in an element that
 * keeps white space). Anything that would read as more than lines of text (a list, a heading) is
 * shown as typed.
 */
export function LearnerText({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text).blocks, [text]);
  if (!blocks.every((block) => block.type === "paragraph")) return text;
  return blocks.map((block, i) => (
    <Fragment key={block.id}>
      {i > 0 && "\n\n"}
      <Inlines inlines={block.children} />
    </Fragment>
  ));
}
