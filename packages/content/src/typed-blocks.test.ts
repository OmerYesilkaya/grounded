import { describe, expect, it } from "vitest";
import { parseBlocks } from "./index.js";

const fence = (lang: string, body: string) => "```" + lang + "\n" + body + "\n```";

describe("parseBlocks: diagrams", () => {
  it("parses caption, highlight and Mermaid source", () => {
    const { blocks, issues } = parseBlocks(
      fence(
        "diagram",
        "caption: Adding one takes three moves.\nhighlight: C\n---\nflowchart TB\n  A --> C",
      ),
    );
    expect(issues).toEqual([]);
    expect(blocks).toEqual([
      {
        id: "b1",
        type: "diagram",
        syntax: "mermaid",
        caption: "Adding one takes three moves.",
        highlight: "C",
        source: "flowchart TB\n  A --> C",
      },
    ]);
  });

  it("reports a missing caption, an empty source and unknown header keys", () => {
    const { blocks, issues } = parseBlocks(fence("diagram", "title: nope\n---\n"));
    expect(blocks).toEqual([]);
    expect(issues.map((i) => i.code)).toEqual([
      "diagram/unknown-key",
      "diagram/missing-caption",
      "diagram/empty-source",
    ]);
    expect(issues[1]).toMatchObject({
      message: 'A diagram needs a "caption:" line stating the one claim it makes.',
      blockId: "b1",
      line: 1,
    });
  });

  it("reports a diagram without the --- separator", () => {
    const { issues } = parseBlocks(fence("diagram", "flowchart TB\n  A --> B"));
    expect(issues.map((i) => i.code)).toEqual(["diagram/missing-separator"]);
  });
});

describe("parseBlocks: steppers", () => {
  it("parses frames separated by --- frame", () => {
    const body = [
      "caption: Worker A copies 5.",
      "---",
      "flowchart TB\n  M --> A",
      "--- frame",
      "caption: Worker B copies 5 too.",
      "---",
      "flowchart TB\n  M --> B",
    ].join("\n");
    const { blocks, issues } = parseBlocks(fence("stepper", body));
    expect(issues).toEqual([]);
    expect(blocks).toEqual([
      {
        id: "b1",
        type: "stepper",
        frames: [
          { caption: "Worker A copies 5.", syntax: "mermaid", source: "flowchart TB\n  M --> A" },
          {
            caption: "Worker B copies 5 too.",
            syntax: "mermaid",
            source: "flowchart TB\n  M --> B",
          },
        ],
      },
    ]);
  });

  it("needs at least two frames", () => {
    const { issues } = parseBlocks(fence("stepper", "caption: only one\n---\nflowchart TB\n  A"));
    expect(issues.map((i) => i.code)).toEqual(["stepper/too-few-frames"]);
  });

  it("reports which frame is broken", () => {
    const { issues } = parseBlocks(
      fence("stepper", "caption: one\n---\nflowchart TB\n  A\n--- frame\n---\nflowchart TB\n  B"),
    );
    expect(issues).toMatchObject([
      { code: "diagram/missing-caption", message: expect.stringContaining("Frame 2") as string },
    ]);
  });
});

describe("parseBlocks: charts", () => {
  it("parses a Vega-Lite spec with its source", () => {
    const { blocks, issues } = parseBlocks(
      fence("chart", 'source: https://example.org/data\n---\n{"mark": "bar"}'),
    );
    expect(issues).toEqual([]);
    expect(blocks).toEqual([
      { id: "b1", type: "chart", spec: { mark: "bar" }, source: "https://example.org/data" },
    ]);
  });

  it("accepts a spec without a header", () => {
    const { blocks } = parseBlocks(fence("chart", '{"mark": "line"}'));
    expect(blocks).toEqual([{ id: "b1", type: "chart", spec: { mark: "line" }, source: null }]);
  });

  it("reports invalid JSON and non-object specs", () => {
    expect(parseBlocks(fence("chart", "{mark: bar}")).issues.map((i) => i.code)).toEqual([
      "chart/invalid-json",
    ]);
    expect(parseBlocks(fence("chart", "[1, 2]")).issues.map((i) => i.code)).toEqual([
      "chart/not-an-object",
    ]);
  });

  it("rejects a spec that would load or link to an address", () => {
    for (const spec of [
      { data: { url: "https://example.org/data.csv" }, mark: "bar" },
      { mark: "point", encoding: { href: { field: "link" } } },
      { layer: [{ mark: "image", encoding: { url: { field: "img" } } }] },
    ])
      expect(parseBlocks(fence("chart", JSON.stringify(spec))).issues.map((i) => i.code)).toEqual([
        "chart/external-data",
      ]);
    expect(
      parseBlocks(fence("chart", '{"data": {"values": [{"a": 1}]}, "mark": "bar"}')).issues,
    ).toEqual([]);
  });
});

describe("parseBlocks: checks", () => {
  it("parses a check with its question", () => {
    const { blocks, issues } = parseBlocks(":::check\nIn one sentence: why 6 and not 7?\n:::");
    expect(issues).toEqual([]);
    expect(blocks).toEqual([
      {
        id: "b1",
        type: "check",
        children: [
          {
            id: "b1.1",
            type: "paragraph",
            children: [{ type: "text", value: "In one sentence: why 6 and not 7?" }],
          },
        ],
      },
    ]);
  });

  it("reports an empty check", () => {
    expect(parseBlocks(":::check\n:::").issues.map((i) => i.code)).toEqual(["check/empty"]);
  });
});

describe("parseBlocks: word and preview cards", () => {
  const paragraph = (id: string, value: string) => ({
    id,
    type: "paragraph",
    children: [{ type: "text", value }],
  });

  it("parses a word card: the word, and what it means", () => {
    const { blocks, issues } = parseBlocks(
      ':::word{term="ontology"}\nThe study of what there is.\n:::',
    );
    expect(issues).toEqual([]);
    expect(blocks).toEqual([
      {
        id: "b1",
        type: "word",
        term: "ontology",
        children: [paragraph("b1.1", "The study of what there is.")],
      },
    ]);
  });

  it("keeps a word card to text", () => {
    const codes = (markdown: string) => parseBlocks(markdown).issues.map((i) => i.code);
    expect(codes(":::word\nWhat it means.\n:::")).toEqual(["word/missing-term"]);
    expect(codes(':::word{term="x"}\n:::')).toEqual(["word/empty"]);
    expect(
      codes(':::word{term="x"}\n```diagram\ncaption: c\n---\nflowchart TB\n  A\n```\n:::'),
    ).toEqual(["word/not-text"]);
  });

  it("parses a preview card, with the track it offers when there is more to it", () => {
    const { blocks, issues } = parseBlocks(
      ':::about{name="Immanuel Kant" track="Kant: what he held and why it mattered"}\nA German philosopher (1724–1804).\n:::',
    );
    expect(issues).toEqual([]);
    expect(blocks).toEqual([
      {
        id: "b1",
        type: "about",
        name: "Immanuel Kant",
        track: "Kant: what he held and why it mattered",
        children: [paragraph("b1.1", "A German philosopher (1724–1804).")],
      },
    ]);
  });

  it("keeps a preview card to one paragraph", () => {
    const codes = (markdown: string) => parseBlocks(markdown).issues.map((i) => i.code);
    expect(codes(":::about\nWho.\n:::")).toEqual(["about/missing-name"]);
    expect(codes(':::about{name="Kant"}\nOne.\n\nTwo.\n:::')).toEqual(["about/not-one-paragraph"]);
  });
});

describe("parseBlocks: media", () => {
  it("parses video, image, audio and link blocks", () => {
    const { blocks, issues } = parseBlocks(
      [
        '::video{id="dQw4w9WgXcQ" start="12" end="40" caption="A real recording."}',
        '::image{ref="commons:File:Octave.svg" caption="Two notes an octave apart."}',
        '::audio{ref="commons:File:Octave.ogg"}',
        '::link{url="https://example.org" title="The spec" why="Defines the term precisely."}',
      ].join("\n\n"),
    );
    expect(issues).toEqual([]);
    expect(blocks).toEqual([
      {
        id: "b1",
        type: "video",
        provider: "youtube",
        videoId: "dQw4w9WgXcQ",
        start: 12,
        end: 40,
        caption: "A real recording.",
      },
      {
        id: "b2",
        type: "image",
        ref: "commons:File:Octave.svg",
        caption: "Two notes an octave apart.",
        file: null,
      },
      { id: "b3", type: "audio", ref: "commons:File:Octave.ogg", caption: null, file: null },
      {
        id: "b4",
        type: "link",
        url: "https://example.org",
        title: "The spec",
        why: "Defines the term precisely.",
      },
    ]);
  });

  it("reports missing attributes and unknown blocks", () => {
    const { blocks, issues } = parseBlocks(
      '::video{start="3"}\n\n::gif{ref="x"}\n\n:::aside\nhi\n:::',
    );
    expect(blocks).toEqual([]);
    expect(issues.map((i) => [i.code, i.message])).toEqual([
      ["video/missing-attribute", 'A video block needs an "id" attribute.'],
      ["unknown-block", 'There is no "gif" block. Allowed blocks are listed in your instructions.'],
      [
        "unknown-block",
        'There is no "aside" block. Allowed blocks are listed in your instructions.',
      ],
    ]);
  });

  it("reports a non-numeric start time", () => {
    expect(parseBlocks('::video{id="x" start="soon"}').issues.map((i) => i.code)).toEqual([
      "video/invalid-time",
    ]);
  });
});
