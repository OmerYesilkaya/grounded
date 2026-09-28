import { describe, expect, it } from "vitest";
import {
  asideAnchorSchema,
  asideBlocksLine,
  asideLesson,
  asidePassage,
  asideRecord,
  stepOfBlock,
} from "./aside.js";

describe("an aside's anchor", () => {
  it("names a block of a lesson step, and the step is the part before the dot", () => {
    const anchor = { blockId: "s2.b3.1", quote: "a copy", prefix: "works on ", suffix: " of it" };
    expect(asideAnchorSchema.safeParse(anchor).success).toBe(true);
    expect(asideAnchorSchema.safeParse({ ...anchor, blockId: "b3" }).success).toBe(false);
    expect(asideAnchorSchema.safeParse({ ...anchor, quote: "  " }).success).toBe(false);
    expect(stepOfBlock("s2.b3.1")).toBe("s2");
  });
});

describe("an aside's prompt", () => {
  it("marks each step of the lesson with whether the learner has reached it", () => {
    expect(
      asideLesson([
        { id: "s1", heading: "Three moves", source: "## Three moves\n\nCopy.", open: true },
        { id: "s2", heading: "Two workers", source: "## Two workers\n\nBoth.", open: false },
        { id: "s3", heading: "Why it hides", source: null, open: false },
      ]),
    ).toBe(
      [
        "### Step 1 (the learner can read it)\n\n## Three moves\n\nCopy.",
        "### Step 2 (still locked: the learner hasn't reached it; don't spoil it)\n\n## Two workers\n\nBoth.",
        "### Step 3 (not written yet): Why it hides",
      ].join("\n\n"),
    );
  });

  it("quotes the passage inside the text around it", () => {
    expect(
      asidePassage(
        { quote: "copied out", prefix: "The value is ", suffix: " into a copy" },
        { number: 1, heading: "Three moves" },
      ),
    ).toBe(
      'In step 1, "Three moves", the learner selected the passage between « and »:\n\n…The value is «copied out» into a copy…',
    );
  });

  it("lists the blocks an answer in the margin may use", () => {
    expect(asideBlocksLine()).toBe(
      "Blocks you may use in this answer: paragraphs, lists, quotes, code, maths, tables, diagrams and steppers. Nothing else is shown.",
    );
  });

  it("records asides for other calls, with what the learner saved", () => {
    const number = (id: string) => Number(id.slice(1));
    expect(asideRecord([], number)).toBeNull();
    expect(
      asideRecord(
        [
          {
            stepId: "s2",
            quote: "both copy 5",
            messages: [
              { role: "learner", text: "Why 5?" },
              { role: "tutor", text: "It was the value then." },
            ],
            saved: "How databases avoid it",
          },
        ],
        number,
      ),
    ).toBe(
      "### On step 2: «both copy 5»\nLearner: Why 5?\nTutor: It was the value then.\nThe learner saved this for a future session: How databases avoid it",
    );
  });
});
