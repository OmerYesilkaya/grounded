import { parseBlocks } from "@grounded/content";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { setThemeChoice } from "@/lib/theme";
import { Blocks } from "./blocks";
import {
  ContentProvider,
  type ChartEngine,
  type DiagramEngine,
  type MediaResolver,
} from "./environment";

const fence = (lang: string, body: string) => "```" + lang + "\n" + body + "\n```";

function renderWith(
  markdown: string,
  env: { diagrams?: DiagramEngine; charts?: ChartEngine; media?: MediaResolver },
) {
  const { blocks, issues } = parseBlocks(markdown);
  expect(issues).toEqual([]);
  return render(
    <ContentProvider diagrams={env.diagrams} charts={env.charts} media={env.media}>
      <Blocks blocks={blocks} />
    </ContentProvider>,
  );
}

const fakeDiagrams = (): DiagramEngine & { render: ReturnType<typeof vi.fn> } => ({
  render: vi.fn((source: string) =>
    Promise.resolve(`<svg><text>${source.split("\n")[1]?.trim() ?? ""}</text></svg>`),
  ),
});

describe("Blocks: diagrams", () => {
  it("renders the engine's drawing with its caption as the figure's name", async () => {
    const diagrams = fakeDiagrams();
    renderWith(
      fence("diagram", "caption: Three moves.\nhighlight: C\n---\nflowchart TB\n  A --> C"),
      { diagrams },
    );

    const figure = await screen.findByRole("figure", { name: "Three moves." });
    expect(await within(figure).findByText("A --> C")).toBeInTheDocument();
    expect(diagrams.render).toHaveBeenCalledWith(
      "flowchart TB\n  A --> C",
      expect.objectContaining({ highlight: "C" }),
    );
  });

  it("keeps the caption and says so when the drawing can't be rendered", async () => {
    renderWith(fence("diagram", "caption: Three moves.\n---\nflowchart TB\n  A"), {
      diagrams: { render: () => Promise.reject(new Error("bad syntax")) },
    });
    expect(await screen.findByText("Diagram unavailable")).toBeInTheDocument();
    expect(screen.getByText("Three moves.")).toBeInTheDocument();
  });

  it("draws in the page's theme, and again when the learner changes it", async () => {
    const diagrams = fakeDiagrams();
    renderWith(fence("diagram", "caption: Three moves.\n---\nflowchart TB\n  A --> C"), {
      diagrams,
    });
    await screen.findByText("A --> C");
    expect(diagrams.render).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ theme: "dark" }),
    );

    act(() => {
      setThemeChoice("light");
    });
    await vi.waitFor(() => {
      expect(diagrams.render).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({ theme: "light" }),
      );
    });
    act(() => {
      setThemeChoice("dark");
    });
  });
});

describe("Blocks: steppers", () => {
  it("moves through frames with next and previous", async () => {
    const user = userEvent.setup();
    const diagrams = fakeDiagrams();
    renderWith(
      fence(
        "stepper",
        "caption: A copies 5.\n---\nflowchart TB\n  M --> A\n--- frame\ncaption: B copies 5.\n---\nflowchart TB\n  M --> B",
      ),
      { diagrams },
    );

    expect(screen.getByText("A copies 5.")).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous frame" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next frame" }));

    expect(screen.getByText("B copies 5.")).toBeInTheDocument();
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    expect(await screen.findByText("M --> B")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next frame" })).toBeDisabled();
  });
});

describe("Blocks: charts", () => {
  it("mounts the spec with the chart engine and shows its source", async () => {
    const charts: ChartEngine = {
      mount: vi.fn((el: HTMLElement) => {
        el.textContent = "a bar chart";
        return Promise.resolve(() => undefined);
      }),
    };
    renderWith(fence("chart", 'source: https://example.org/data\n---\n{"mark": "bar"}'), {
      charts,
    });

    expect(await screen.findByText("a bar chart")).toBeInTheDocument();
    expect(charts.mount).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      { mark: "bar" },
      expect.any(String),
    );
    expect(screen.getByRole("link", { name: "example.org" })).toHaveAttribute(
      "href",
      "https://example.org/data",
    );
  });
});

describe("Blocks: media", () => {
  const media: MediaResolver = (ref) =>
    ref === "commons:File:Octave.svg"
      ? { url: "https://upload.example/octave.svg", credit: "Jane Doe", license: "CC BY-SA 4.0" }
      : ref === "commons:File:Octave.ogg"
        ? { url: "https://upload.example/octave.ogg" }
        : null;

  it("renders verified images, audio, video clips and link cards", () => {
    const { container } = renderWith(
      [
        '::image{ref="commons:File:Octave.svg" caption="Two notes an octave apart."}',
        '::audio{ref="commons:File:Octave.ogg" caption="Hear it."}',
        '::video{id="abc123" start="12" end="40" caption="A recording."}',
        '::link{url="https://example.org/spec" title="The spec" why="Defines it precisely."}',
      ].join("\n\n"),
      { media },
    );

    const image = screen.getByRole("img", { name: "Two notes an octave apart." });
    expect(image).toHaveAttribute("src", "https://upload.example/octave.svg");
    expect(screen.getByText("Jane Doe · CC BY-SA 4.0")).toBeInTheDocument();
    expect(container.querySelector("audio")).toHaveAttribute(
      "src",
      "https://upload.example/octave.ogg",
    );
    expect(screen.getByTitle("A recording.")).toHaveAttribute(
      "src",
      "https://www.youtube-nocookie.com/embed/abc123?start=12&end=40",
    );
    const card = screen.getByRole("link", { name: /The spec/ });
    expect(card).toHaveAttribute("href", "https://example.org/spec");
    expect(within(card).getByText("Defines it precisely.")).toBeInTheDocument();
    expect(within(card).getByText("example.org")).toBeInTheDocument();
  });

  it("shows a quiet note for media that couldn't be verified", () => {
    renderWith('::image{ref="commons:File:Missing.png" caption="Gone."}', { media });
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Media unavailable")).toBeInTheDocument();
  });
});
