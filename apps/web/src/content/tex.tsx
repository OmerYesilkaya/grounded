import katex from "katex";
import "katex/dist/katex.min.css";
import { useMemo } from "react";

/** KaTeX output is generated from the source with trust off, so it carries no model-written markup. */
export function Tex({ tex, display }: { tex: string; display: boolean }) {
  const html = useMemo(
    () => katex.renderToString(tex, { displayMode: display, throwOnError: false, trust: false }),
    [tex, display],
  );
  const Tag = display ? "div" : "span";
  return (
    <Tag
      className={display ? "my-5 overflow-x-auto" : undefined}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
