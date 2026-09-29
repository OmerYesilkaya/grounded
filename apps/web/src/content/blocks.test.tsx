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

describe("Blocks: cards", () => {
  it("sets a word card apart: the word, then what it means", () => {
    renderMarkdown(':::word{term="ontology"}\nThe study of what there is.\n:::');
    const card = screen.getByRole("complementary", { name: "New word: ontology" });
    expect(within(card).getByText("ontology")).toBeInTheDocument();
    expect(within(card).getByText("The study of what there is.")).toBeInTheDocument();
  });

  it("offers a track of its own from a preview card with more to it, in a new tab", () => {
    renderMarkdown(
      ':::about{name="Immanuel Kant" track="Kant: what he held and why it mattered"}\nA German philosopher (1724–1804).\n:::',
    );
    const card = screen.getByRole("complementary", { name: "About Immanuel Kant" });
    const link = within(card).getByRole("link", { name: "Make a track about this" });
    expect(link).toHaveAttribute(
      "href",
      "/tracks/new?goal=Kant%3A%20what%20he%20held%20and%20why%20it%20mattered",
    );
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("offers no track from a preview card that says it all", () => {
    renderMarkdown(':::about{name="Nile"}\nThe river Egypt grew along.\n:::');
    expect(screen.queryByRole("link")).toBeNull();
  });
});
