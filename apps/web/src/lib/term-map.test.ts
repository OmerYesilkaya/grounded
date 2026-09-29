import { describe, expect, it } from "vitest";
import { layers, type TermMap } from "./term-map";

const node = (term: string) => ({ term, standing: "owned" as const, focus: true });

describe("layers", () => {
  it("puts every idea above what it rests on, the ground at the bottom", () => {
    const map: TermMap = {
      nodes: ["memory", "thread", "shared memory", "lost update"].map(node),
      edges: [
        { term: "shared memory", restsOn: "memory" },
        { term: "shared memory", restsOn: "thread" },
        { term: "lost update", restsOn: "shared memory" },
      ],
    };
    expect(layers(map)).toEqual([["lost update"], ["shared memory"], ["memory", "thread"]]);
  });

  it("orders a row to keep lines short, and draws the same map the same way every time", () => {
    const map: TermMap = {
      nodes: ["a", "b", "x on b", "y on a"].map(node),
      edges: [
        { term: "x on b", restsOn: "b" },
        { term: "y on a", restsOn: "a" },
      ],
    };
    const rows = layers(map);
    expect(rows).toEqual([
      ["y on a", "x on b"],
      ["a", "b"],
    ]);
    expect(layers(map)).toEqual(rows);
  });

  it("draws a cycle without looping, and ignores lines to ideas it doesn't show", () => {
    const map: TermMap = {
      nodes: ["a", "b"].map(node),
      edges: [
        { term: "a", restsOn: "b" },
        { term: "b", restsOn: "a" },
        { term: "a", restsOn: "missing" },
      ],
    };
    expect(layers(map).flat().toSorted()).toEqual(["a", "b"]);
  });
});
