import type { ImportReading } from "@grounded/core";
import { describe, expect, it } from "vitest";
import { buildEdits } from "./edits.js";
import { importProblems } from "./import-track.js";
import type { LedgerTerm } from "./ledger.js";

const term = (name: string, status: LedgerTerm["status"], evidence = ""): LedgerTerm => ({
  term: name,
  status,
  evidence,
  alsoIn: [],
});

const TERMS = [
  term("stack", "assumed", "Held before teaching (probe)"),
  term("closure", "confirmed", "homework A"),
  term("microtask queue", "taught", "Session 2 lesson"),
  term("event loop", "planned"),
];

const reading = (overrides: Partial<ImportReading> = {}): ImportReading => ({
  dependencies: [],
  arcs: [],
  fixItems: [],
  planNotes: "",
  unplaced: [],
  ...overrides,
});

describe("buildEdits", () => {
  it("creates every term after what it rests on, then the statuses, the plan and the fix-list", () => {
    const edits = buildEdits(
      TERMS,
      reading({
        // closure rests on the event loop, listed after it: the event loop is created first.
        dependencies: [
          { term: 2, restsOn: [4, 1] },
          { term: 3, restsOn: [4] },
        ],
        arcs: [{ title: "A — async", terms: [4, 3, 3] }],
        fixItems: [" Believes a closure copies values. ", "believes a closure copies values.", ""],
        planNotes: " Arc A next. ",
      }),
    );

    expect(edits.actions).toEqual([
      { type: "set-language", language: "English" },
      { type: "add-planned-term", term: "stack", restsOn: [] },
      { type: "add-planned-term", term: "event loop", restsOn: [] },
      { type: "add-planned-term", term: "closure", restsOn: ["stack", "event loop"] },
      { type: "add-planned-term", term: "microtask queue", restsOn: ["event loop"] },
      {
        type: "set-term-status",
        term: "stack",
        status: "assumed",
        evidence: "Held before teaching (probe)",
      },
      { type: "set-term-status", term: "closure", status: "confirmed", evidence: "homework A" },
      {
        type: "set-term-status",
        term: "microtask queue",
        status: "taught",
        evidence: "Session 2 lesson",
      },
      {
        type: "set-plan",
        arcs: [{ title: "A — async", terms: ["event loop", "microtask queue"] }],
        notes: "Arc A next.",
      },
      { type: "add-fix-item", text: "Believes a closure copies values." },
    ]);
    expect(edits.unplaced).toEqual([]);
    expect(importProblems(edits.actions)).toEqual([]);
  });

  it("leaves out and reports ids that name no term", () => {
    const edits = buildEdits(
      TERMS,
      reading({
        dependencies: [
          { term: 9, restsOn: [1] },
          { term: 2, restsOn: [0, 1.5, 1, 2] },
        ],
        arcs: [{ title: " ", terms: [3, 42] }],
        unplaced: ["The map's roots are sentences."],
      }),
    );

    expect(edits.unplaced).toEqual([
      "A dependency named term 9, which isn't in the list; left out.",
      `"closure" was said to rest on term 0, which isn't in the list; left out.`,
      `"closure" was said to rest on term 1.5, which isn't in the list; left out.`,
      `"closure" was said to rest on itself; left out.`,
      `Arc "Arc 1" listed term 42, which isn't in the list; left out.`,
      "The map's roots are sentences.",
    ]);
    expect(edits.actions).toContainEqual({
      type: "add-planned-term",
      term: "closure",
      restsOn: ["stack"],
    });
    expect(edits.actions).toContainEqual({
      type: "set-plan",
      arcs: [{ title: "Arc 1", terms: ["microtask queue"] }],
      notes: "",
    });
    expect(importProblems(edits.actions)).toEqual([]);
  });

  it("breaks a dependency cycle at the edge that closes it, and reports it", () => {
    const edits = buildEdits(
      TERMS,
      reading({
        dependencies: [
          { term: 1, restsOn: [3] },
          { term: 3, restsOn: [4] },
          { term: 4, restsOn: [1] },
        ],
      }),
    );

    expect(edits.unplaced).toEqual([
      `"event loop" was said to rest on "stack", which already rests on it (directly or through other terms): a cycle; that edge was left out.`,
    ]);
    expect(edits.actions.filter((a) => a.type === "add-planned-term")).toEqual([
      { type: "add-planned-term", term: "event loop", restsOn: [] },
      { type: "add-planned-term", term: "microtask queue", restsOn: ["event loop"] },
      { type: "add-planned-term", term: "stack", restsOn: ["microtask queue"] },
      { type: "add-planned-term", term: "closure", restsOn: [] },
    ]);
    expect(importProblems(edits.actions)).toEqual([]);
  });

  it("gives a status without evidence in the ledger its section as evidence", () => {
    const edits = buildEdits([term("closure", "confirmed")], reading());
    expect(edits.actions).toContainEqual({
      type: "set-term-status",
      term: "closure",
      status: "confirmed",
      evidence: "Listed as confirmed in the ledger.",
    });
  });
});
