import { describe, expect, it } from "vitest";
import type { TermRow } from "./prompt.js";
import { selectTrackView } from "./track-view.js";

const terms: TermRow[] = [
  { term: "bit", status: "assumed", restsOn: [] },
  { term: "memory", status: "confirmed", restsOn: ["bit"] },
  { term: "register", status: "confirmed", restsOn: ["memory"] },
  { term: "packet", status: "confirmed", restsOn: [] },
  { term: "working copy", status: "taught", restsOn: ["register"] },
  { term: "lost update", status: "planned", restsOn: ["working copy"] },
  { term: "lock", status: "planned", restsOn: [] },
  { term: "TCP", status: "planned", restsOn: ["packet"] },
];

const arcs = [
  { title: "Memory", terms: ["bit", "memory", "register"] },
  { title: "Concurrency", terms: ["working copy", "lost update", "lock"] },
  { title: "Networks", terms: ["packet", "TCP"] },
];

describe("selectTrackView", () => {
  it("lists the current arc's terms and everything they rest on, and counts the rest", () => {
    const view = selectTrackView({ terms, arcs, touched: [], wholePlan: false });
    expect(view.terms.map((t) => t.term)).toEqual([
      "bit",
      "memory",
      "register",
      "working copy",
      "lost update",
      "lock",
    ]);
    expect(view.termsNotListed).toEqual({ planned: 1, confirmed: 1 });
  });

  it("takes the current arc to be the first in plan order with a planned term", () => {
    const view = selectTrackView({ terms, arcs, touched: [], wholePlan: false });
    expect(view.arcs.map((a) => a.current ?? false)).toEqual([false, true, false]);
    const planned = terms.map((t) =>
      t.term === "lost update" || t.term === "lock" ? { ...t, status: "taught" as const } : t,
    );
    const next = selectTrackView({ terms: planned, arcs, touched: [], wholePlan: false });
    expect(next.arcs.map((a) => a.current ?? false)).toEqual([false, false, true]);
  });

  it("lists the terms touched recently, with what they rest on, whatever their arc", () => {
    const view = selectTrackView({ terms, arcs, touched: ["TCP"], wholePlan: false });
    expect(view.terms.map((t) => t.term)).toContain("TCP");
    expect(view.terms.map((t) => t.term)).toContain("packet");
    expect(view.termsNotListed).toEqual({});
  });

  it("shows the other arcs as tallies, unless the phase sees the whole plan", () => {
    const view = selectTrackView({ terms, arcs, touched: [], wholePlan: false });
    expect(view.arcs).toEqual([
      { ...arcs[0], tally: { assumed: 1, confirmed: 2 } },
      { ...arcs[1], current: true },
      { ...arcs[2], tally: { confirmed: 1, planned: 1 } },
    ]);
    const whole = selectTrackView({ terms, arcs, touched: [], wholePlan: true });
    expect(whole.arcs).toEqual([arcs[0], { ...arcs[1], current: true }, arcs[2]]);
  });

  it("lists only what was touched when no arc has a planned term left", () => {
    const done = terms.map((t) => ({ ...t, status: "confirmed" as const }));
    const view = selectTrackView({ terms: done, arcs, touched: ["memory"], wholePlan: false });
    expect(view.terms.map((t) => t.term)).toEqual(["bit", "memory"]);
    expect(view.arcs.some((a) => a.current)).toBe(false);
  });
});
