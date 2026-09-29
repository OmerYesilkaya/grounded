import { describe, expect, it } from "vitest";
import { arcsClosedBy, keepClosedArcs } from "./arc-exam.js";
import type { TermStatus } from "./prompt.js";

const statuses = (entries: Record<string, TermStatus>) => new Map(Object.entries(entries));

const arcs = [
  { title: "Processes", terms: ["process", "address space"] },
  { title: "Threads", terms: ["thread", "race"] },
];

describe("arcsClosedBy", () => {
  it("closes the arc whose last planned terms this session's lesson introduced", () => {
    const closed = arcsClosedBy({
      arcs,
      before: statuses({ process: "confirmed", "address space": "planned", thread: "planned" }),
      // The lesson's checks haven't settled every term yet: an unchecked one is still planned.
      now: statuses({ process: "confirmed", "address space": "planned", thread: "planned" }),
      introduced: ["Address space"],
    });
    expect(closed.map((a) => a.title)).toEqual(["Processes"]);
  });

  it("leaves an arc open while any of its terms is left to teach", () => {
    const closed = arcsClosedBy({
      arcs,
      before: statuses({ thread: "planned", race: "planned" }),
      now: statuses({ thread: "taught", race: "planned" }),
      introduced: ["thread"],
    });
    expect(closed.map((a) => a.title)).not.toContain("Threads");
  });

  it("counts a term added during the session as planned when it began", () => {
    const closed = arcsClosedBy({
      arcs: [{ title: "Threads", terms: ["thread", "race"] }],
      before: statuses({ thread: "taught" }),
      now: statuses({ thread: "taught", race: "planned" }),
      introduced: ["race"],
    });
    expect(closed).toHaveLength(1);
  });

  it("doesn't close an arc that was taught before the session, even when its lesson teaches a term again", () => {
    const closed = arcsClosedBy({
      arcs,
      before: statuses({ process: "taught", "address space": "confirmed" }),
      now: statuses({ process: "taught", "address space": "confirmed" }),
      introduced: ["process"],
    });
    expect(closed).toEqual([]);
  });

  it("sets no exam for an arc one session teaches whole", () => {
    const closed = arcsClosedBy({
      arcs,
      before: statuses({ process: "planned", "address space": "planned" }),
      now: statuses({ process: "taught", "address space": "planned" }),
      introduced: ["process", "address space"],
    });
    expect(closed).toEqual([]);
  });

  it("never closes an arc twice, or an empty one", () => {
    const closed = arcsClosedBy({
      arcs: [
        { title: "Processes", terms: ["process", "fork"], closedIn: "s1" },
        { title: "Nothing yet", terms: [] },
      ],
      before: statuses({ process: "confirmed", fork: "planned" }),
      now: statuses({ process: "confirmed", fork: "planned" }),
      introduced: ["fork"],
    });
    expect(closed).toEqual([]);
  });
});

describe("keepClosedArcs", () => {
  const before = [
    { title: "Processes", terms: ["process", "address space"], closedIn: "s3" },
    { title: "Threads", terms: ["thread"] },
  ];

  it("keeps a closed arc closed under its title, or renamed with the same terms", () => {
    expect(
      keepClosedArcs(before, [
        { title: "processes", terms: ["process", "address space", "fork"] },
        { title: "Threads", terms: ["thread"] },
      ]),
    ).toEqual([
      { title: "processes", terms: ["process", "address space", "fork"], closedIn: "s3" },
      { title: "Threads", terms: ["thread"] },
    ]);
    expect(
      keepClosedArcs(before, [{ title: "Programs running", terms: ["Address space", "process"] }]),
    ).toEqual([{ title: "Programs running", terms: ["Address space", "process"], closedIn: "s3" }]);
  });
});
