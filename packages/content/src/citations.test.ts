import { describe, expect, it } from "vitest";
import { citedSources, type Inline, type LessonStep } from "./index.js";

const cite = (url: string, title = url): Inline => ({
  type: "cite",
  ref: 1,
  source: { url, title },
});

const step = (id: string, body: LessonStep["body"], check: LessonStep["check"] = null) => ({
  id,
  heading: [{ type: "text" as const, value: id }],
  body,
  check,
});

describe("citedSources", () => {
  it("lists each source once, in the order the lesson first cites it, wherever it is cited", () => {
    const steps: LessonStep[] = [
      step("s1", [
        {
          id: "s1.b2",
          type: "paragraph",
          children: [cite("https://b.org"), cite("https://a.org")],
        },
        {
          id: "s1.b3",
          type: "list",
          ordered: false,
          items: [[{ id: "s1.b3.1.1", type: "paragraph", children: [cite("https://a.org")] }]],
        },
      ]),
      step(
        "s2",
        [
          {
            id: "s2.b2",
            type: "word",
            term: "lost update",
            children: [
              {
                id: "s2.b2.1",
                type: "paragraph",
                children: [{ type: "strong", children: [cite("https://c.org")] }],
              },
            ],
          },
          { id: "s2.b3", type: "table", header: [[cite("https://d.org")]], rows: [] },
        ],
        {
          id: "s2.b4",
          type: "check",
          children: [{ id: "s2.b4.1", type: "paragraph", children: [cite("https://e.org")] }],
        },
      ),
    ];
    expect(citedSources(steps).map((s) => s.url)).toEqual([
      "https://b.org",
      "https://a.org",
      "https://c.org",
      "https://d.org",
      "https://e.org",
    ]);
  });

  it("leaves out a citation whose source was never resolved", () => {
    const steps = [
      step("s1", [
        { id: "s1.b2", type: "paragraph", children: [{ type: "cite", ref: 1, source: null }] },
      ]),
    ];
    expect(citedSources(steps)).toEqual([]);
  });
});
