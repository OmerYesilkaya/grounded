import { parseBlocks } from "@grounded/content";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Blocks } from "./blocks";

const renderMarkdown = (markdown: string) => {
  const { blocks, issues } = parseBlocks(markdown);
  expect(issues).toEqual([]);
  return render(<Blocks blocks={blocks} />);
};

describe("Blocks: text", () => {
  it("renders headings and paragraphs with inline formatting", () => {
    renderMarkdown(
      "## Three moves\n\nAn **idea**, _stated_, as `x += 1`, see [docs](https://example.org).",
    );

    expect(screen.getByRole("heading", { level: 2, name: "Three moves" })).toBeInTheDocument();
    expect(screen.getByText("idea").tagName).toBe("STRONG");
    expect(screen.getByText("stated").tagName).toBe("EM");
    expect(screen.getByText("x += 1").tagName).toBe("CODE");
    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("href", "https://example.org");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders lists, quotes and tables", () => {
    renderMarkdown(
      "1. copy out\n2. change\n\n> put back\n\n| worker | sees |\n| --- | --- |\n| A | 5 |",
    );

    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["copy out", "change"]);
    expect(screen.getByText("put back").closest("blockquote")).not.toBeNull();
    const table = screen.getByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual(["worker", "sees"]);
    expect(
      within(table)
        .getAllByRole("cell")
        .map((td) => td.textContent),
    ).toEqual(["A", "5"]);
  });

  it("typesets inline and display maths", () => {
    const { container } = renderMarkdown("Energy $E$ is\n\n$$\nE = mc^2\n$$");
    const annotations = [...container.querySelectorAll("annotation")].map((a) => a.textContent);
    expect(annotations).toEqual(["E", "E = mc^2"]);
  });

  it("shows code with its language before highlighting arrives", () => {
    renderMarkdown("```js\nlet n = 5;\n```");
    expect(screen.getByText("let n = 5;")).toBeInTheDocument();
    expect(screen.getByText("js")).toBeInTheDocument();
  });
});

describe("Blocks: maths and punctuation", () => {
  it("keeps punctuation right after inline maths on the same line", () => {
    const { container } = renderMarkdown("anywhere from $5 + 1$ to $5 + n$. Then more.");
    const glued = container.querySelector(".whitespace-nowrap");
    expect(glued?.querySelector("annotation")?.textContent).toBe("5 + n");
    expect(glued?.textContent.endsWith(".")).toBe(true);
    expect(container.textContent).toContain(" Then more.");
  });
});
