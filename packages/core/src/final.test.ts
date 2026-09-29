import { describe, expect, it } from "vitest";
import { breakDemotions, finalStanding } from "./index.js";

const ARCS = [{ terms: ["working copy", "lost update"] }, { terms: ["lock", "Deadlock"] }];
const closedNormal = { final: false, closed: true };

describe("where a track stands towards its final", () => {
  it("offers the final once no term of the plan's arcs is still planned", () => {
    const standing = (planned: string[], latest = closedNormal) =>
      finalStanding({ arcs: ARCS, planned, examsOpen: 0, latest });
    expect(standing(["deadlock"])).toBe("not-yet");
    // A planned term no arc holds doesn't keep the plan open.
    expect(standing(["a tangent saved for later"])).toBe("ready");
    expect(standing([])).toBe("ready");
  });

  it("waits for the arc exams to be handed in", () => {
    expect(finalStanding({ arcs: ARCS, planned: [], examsOpen: 1, latest: closedNormal })).toBe(
      "after-exam",
    );
  });

  it("offers nothing on a track with no plan yet", () => {
    expect(finalStanding({ arcs: [], planned: [], examsOpen: 0, latest: null })).toBe("not-yet");
  });

  it("is finished once its final closes, until another session starts", () => {
    const at = (latest: { final: boolean; closed: boolean }) =>
      finalStanding({ arcs: ARCS, planned: [], examsOpen: 0, latest });
    expect(at({ final: true, closed: true })).toBe("finished");
    expect(at({ final: true, closed: false })).toBe("ready");
    // A session after it takes up the new fix-list; a new arc planned there opens the plan again.
    expect(
      finalStanding({ arcs: ARCS, planned: ["deadlock"], examsOpen: 0, latest: closedNormal }),
    ).toBe("not-yet");
  });
});

describe("the teach-back's breaks", () => {
  const terms = [
    { term: "working copy", status: "confirmed" },
    { term: "lost update", status: "taught" },
    { term: "lock", status: "borrowed" },
  ];

  it("take a held term back to taught, with the learner's words", () => {
    expect(
      breakDemotions(
        [
          { term: "Working copy", quote: " it just is " },
          { term: "lock", quote: "that's how locks work" },
        ],
        terms,
      ),
    ).toEqual([
      {
        type: "set-term-status",
        term: "Working copy",
        status: "taught",
        evidence: "Couldn't say why in the final's teach-back: “it just is”",
      },
      {
        type: "set-term-status",
        term: "lock",
        status: "taught",
        evidence: "Couldn't say why in the final's teach-back: “that's how locks work”",
      },
    ]);
  });

  it("leave a term alone that isn't held, isn't on the list, or was taken back already", () => {
    expect(
      breakDemotions(
        [
          { term: "lost update", quote: "it just happens" },
          { term: null, quote: "no idea why" },
          { term: "race", quote: "it just is" },
          { term: "working copy", quote: "it just is" },
          { term: "working copy", quote: "because" },
        ],
        terms,
      ),
    ).toHaveLength(1);
  });
});
