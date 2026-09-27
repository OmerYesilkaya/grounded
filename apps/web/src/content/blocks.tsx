import type { Block } from "@grounded/content";
import { CodeBlock } from "./code-block";
import { AudioView, ImageView, LinkCardView, VideoView } from "./media-blocks";
import { Inlines } from "./inlines";
import { Tex } from "./tex";
import { ChartView, DiagramView, StepperView } from "./visual-blocks";

/** Renders a validated block tree. Model output never reaches the DOM any other way. */
export function Blocks({ blocks }: { blocks: readonly Block[] }) {
  return blocks.map((block) => <BlockView key={block.id} block={block} />);
}

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case "heading": {
      const Tag = `h${String(Math.min(Math.max(block.depth, 2), 4))}` as "h2" | "h3" | "h4";
      return (
        <Tag
          data-block={block.id}
          className="mt-8 mb-3 font-serif font-semibold tracking-tight first:mt-0"
        >
          <Inlines inlines={block.children} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p data-block={block.id} className="mb-4">
          <Inlines inlines={block.children} />
        </p>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag
          data-block={block.id}
          className={block.ordered ? "mb-4 list-decimal pl-6" : "mb-4 list-disc pl-6"}
        >
          {block.items.map((item, i) => (
            <li key={i} className="mb-1 [&>p]:mb-0">
              <Blocks blocks={item} />
            </li>
          ))}
        </Tag>
      );
    }
    case "quote":
      return (
        <blockquote
          data-block={block.id}
          className="mb-4 border-l-2 border-border-strong pl-4 text-muted-foreground"
        >
          <Blocks blocks={block.children} />
        </blockquote>
      );
    case "code":
      return <CodeBlock code={block.value} lang={block.lang} />;
    case "math":
      return <Tex tex={block.value} display />;
    case "table":
      return (
        <div className="my-5 overflow-x-auto">
          <table data-block={block.id} className="w-full border-collapse font-sans text-sm">
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th
                    key={i}
                    className="border-b border-border-strong px-3 py-2 text-left font-medium"
                  >
                    <Inlines inlines={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className="border-b px-3 py-2">
                      <Inlines inlines={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "divider":
      return <hr className="my-8" />;
    case "diagram":
      return <DiagramView block={block} />;
    case "stepper":
      return <StepperView block={block} />;
    case "chart":
      return <ChartView block={block} />;
    case "image":
      return <ImageView block={block} />;
    case "audio":
      return <AudioView block={block} />;
    case "video":
      return <VideoView block={block} />;
    case "link":
      return <LinkCardView block={block} />;
    case "check":
      // Checks are interactive; LessonView renders them with the step's progress.
      return null;
  }
}
