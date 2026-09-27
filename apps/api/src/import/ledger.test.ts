import { describe, expect, it } from "vitest";
import { STATE } from "../test/learning-fixture.js";
import { sectionsOf } from "./learning-folder.js";
import { ASSUMED_EVIDENCE, mergeLedger, parseLedger } from "./ledger.js";

const fixtureLedger = () => parseLedger(sectionsOf(STATE).get("Ledger") ?? "");

describe("parseLedger", () => {
  it("reads every row and item of the four sections, with its evidence", () => {
    const ledger = fixtureLedger();

    expect(ledger.counts).toEqual({ assumed: 6, confirmed: 3, taught: 2, planned: 7 });
    expect(ledger.skipped).toEqual([]);
    const probeFloor = `${ASSUMED_EVIDENCE} — P1 probe floors (2026-01-04)`;
    expect(ledger.entries).toEqual([
      // A list across lines, with a trailing "·", a bullet line and a bold note label.
      { term: "knife", status: "assumed", evidence: ASSUMED_EVIDENCE },
      { term: "stove", status: "assumed", evidence: ASSUMED_EVIDENCE },
      { term: "boiling water (probe floor)", status: "assumed", evidence: ASSUMED_EVIDENCE },
      { term: "salt dissolves", status: "assumed", evidence: ASSUMED_EVIDENCE },
      { term: "a whisk mixes air in", status: "assumed", evidence: probeFloor },
      { term: "oil floats on water", status: "assumed", evidence: probeFloor },
      // A two-column table split by a blank line; the row's wording is the term.
      {
        term: "heat moves from the hot pan into the food (conduction)",
        status: "confirmed",
        evidence: 'Session 1 check 2: "the pan warms the egg from below"',
      },
      { term: "a lid traps steam", status: "confirmed", evidence: "Session 1 check 3" },
      {
        term: "salt raises the boiling point only slightly",
        status: "confirmed",
        evidence: "Session 2 homework",
      },
      // A three-column table: the other columns joined, empty ones left out.
      {
        term: "Maillard reaction",
        status: "taught",
        evidence: "Session 2 lesson; check leaked once",
      },
      { term: "emulsion", status: "taught", evidence: "Session 3 lesson" },
      // A "from S3:" prefix for its line, a parenthesised group, an item running onto the next line.
      { term: "roux", status: "planned", evidence: "" },
      { term: "hollandaise", status: "planned", evidence: "from S3" },
      { term: "mayonnaise", status: "planned", evidence: "from S3" },
      { term: "Emulsion", status: "planned", evidence: "from S3" },
      { term: "beurre blanc", status: "planned", evidence: "arc B remaining" },
      { term: "pan sauce", status: "planned", evidence: "arc B remaining" },
      { term: "bread crust", status: "planned", evidence: "" },
    ]);
  });

  it("keeps a semicolon inside an item outside a labelled note, and parentheses whole", () => {
    const ledger = parseLedger(
      "### Assumed\nWi-Fi is radio; the router is first (probe floor) · a (b · c; d) e\n",
    );
    expect(ledger.entries.map((e) => e.term)).toEqual([
      "Wi-Fi is radio; the router is first (probe floor)",
      "a (b · c; d) e",
    ]);
  });

  it("reports what it can't classify instead of guessing", () => {
    const ledger = parseLedger(
      [
        "Written by the tutor.",
        "### Confirmed",
        "| Term | Evidence |",
        "| --- | --- |",
        "| closure | check 1 |",
        "a stray note",
        "|  | no term |",
        "### Parked",
        "something",
      ].join("\n"),
    );
    expect(ledger.entries).toEqual([{ term: "closure", status: "confirmed", evidence: "check 1" }]);
    expect(ledger.skipped).toEqual([
      "Ledger line outside a section: Written by the tutor.",
      "Not a table row under confirmed: a stray note",
      "A confirmed row without a term: | no term |",
      "Ledger section not understood: ### Parked",
      "Ledger line outside a section: something",
    ]);
  });
});

describe("mergeLedger", () => {
  it("keeps one term per name: the strongest status, with the others' evidence appended", () => {
    const terms = mergeLedger(fixtureLedger().entries);

    expect(terms).toHaveLength(17);
    expect(terms.find((t) => t.term.toLowerCase() === "emulsion")).toEqual({
      term: "emulsion",
      status: "taught",
      evidence: "Session 3 lesson; also listed as planned: from S3",
      alsoIn: ["planned"],
    });
    expect(
      mergeLedger([
        { term: "Closure", status: "planned", evidence: "" },
        { term: "closure", status: "assumed", evidence: ASSUMED_EVIDENCE },
        { term: "CLOSURE", status: "confirmed", evidence: "check 1" },
      ]),
    ).toEqual([
      {
        term: "CLOSURE",
        status: "confirmed",
        evidence: `check 1; also listed as assumed: ${ASSUMED_EVIDENCE}; also listed as planned`,
        alsoIn: ["assumed", "planned"],
      },
    ]);
  });
});
