import type { Inline } from "@grounded/content";
import { Tex } from "./tex";

export function Inlines({ inlines }: { inlines: readonly Inline[] }) {
  return inlines.map((inline, i) => <InlineView key={i} inline={inline} />);
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
    case "break":
      return <br />;
  }
}
