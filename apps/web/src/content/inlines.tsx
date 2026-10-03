import type { Inline } from "@grounded/content";
import type { ReactNode } from "react";
import { CitationMark } from "./citations";
import { Tex } from "./tex";

export function Inlines({ inlines }: { inlines: readonly Inline[] }) {
  const out: ReactNode[] = [];
  for (let i = 0; i < inlines.length; i++) {
    const inline = inlines[i];
    const next = inlines[i + 1];
    if (!inline) continue;
    // A line may break between a formula and the punctuation after it; keep them together.
    const punctuation =
      inline.type === "inlineMath" && next?.type === "text"
        ? /^[.,;:!?)\]]+/.exec(next.value)?.[0]
        : undefined;
    if (inline.type === "inlineMath" && next?.type === "text" && punctuation) {
      out.push(
        <span key={i} className="whitespace-nowrap">
          <Tex tex={inline.value} display={false} />
          {punctuation}
        </span>,
      );
      out.push(next.value.slice(punctuation.length));
      i++;
      continue;
    }
    out.push(<InlineView key={i} inline={inline} />);
  }
  return out;
}

function InlineView({ inline }: { inline: Inline }) {
  switch (inline.type) {
    case "text":
      return inline.value;
    case "strong":
      return (
        <strong className="font-semibold">
          <Inlines inlines={inline.children} />
        </strong>
      );
    case "emphasis":
      return (
        <em>
          <Inlines inlines={inline.children} />
        </em>
      );
    case "inlineCode":
      return (
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.82em]">
          {inline.value}
        </code>
      );
    case "inlineMath":
      return <Tex tex={inline.value} display={false} />;
    case "link":
      return (
        <a
          href={inline.url}
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-border-strong underline-offset-2 hover:decoration-primary"
        >
          <Inlines inlines={inline.children} />
        </a>
      );
    case "cite":
      return <CitationMark source={inline.source} />;
    case "break":
      return <br />;
  }
}
