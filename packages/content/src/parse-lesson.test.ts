import { describe, expect, it } from "vitest";
import { parseLesson, splitLessonSteps } from "./index.js";

const step = (title: string, body: string, check = ":::check\nOne sentence: why?\n:::") =>
  `## ${title}\n\n${body}\n\n${check}`;

describe("parseLesson", () => {
  it("splits a lesson into steps, each with its heading, body and check", () => {
    const { steps, issues } = parseLesson(
      [
        step("Adding one is three moves", "Copy, change, put back."),
        step("Two workers", "Both copy 5."),
      ].join("\n\n"),
    );

    expect(issues).toEqual([]);
    expect(steps).toEqual([
      {
        id: "s1",
        heading: [{ type: "text", value: "Adding one is three moves" }],
        body: [
          {
            id: "s1.b2",
            type: "paragraph",
            children: [{ type: "text", value: "Copy, change, put back." }],
          },
        ],
        check: {
          id: "s1.b3",
          type: "check",
          children: [
            {
              id: "s1.b3.1",
              type: "paragraph",
              children: [{ type: "text", value: "One sentence: why?" }],
            },
          ],
        },
      },
      {
        id: "s2",
        heading: [{ type: "text", value: "Two workers" }],
        body: [
          { id: "s2.b2", type: "paragraph", children: [{ type: "text", value: "Both copy 5." }] },
        ],
        check: expect.objectContaining({ id: "s2.b3", type: "check" }) as unknown,
      },
    ]);
  });

  it("keeps subheadings inside a step", () => {
    const { steps, issues } = parseLesson(step("Idea", "### A detail\n\nText."));
    expect(issues).toEqual([]);
    expect(steps[0]?.body.map((b) => b.type)).toEqual(["heading", "paragraph"]);
  });

  it("reports structural problems per step, and returns only the sound steps", () => {
    const { steps, issues } = parseLesson(
      [
        "Some text before any step.",
        step("Two checks", "Body.", ":::check\nOne?\n:::\n\n:::check\nTwo?\n:::"),
        step("Check in the middle", ":::check\nEarly?\n:::", "More text after it."),
        step("Fine", "Body."),
      ].join("\n\n"),
    );

    expect(steps.map((s) => s.id)).toEqual(["s3"]);
    expect(issues.map((i) => [i.code, i.stepId])).toEqual([
      ["lesson/content-before-first-step", undefined],
      ["lesson/multiple-checks", "s1"],
      ["lesson/check-not-last", "s2"],
    ]);
    expect(issues[1]?.message).toBe(
      'Step "Two checks" has 2 checks; a step ends with at most one.',
    );
  });

  it("parses a step without a check: which steps have one is the lesson pipeline's to say", () => {
    const { steps, issues } = parseLesson(step("Background", "Body.", ""));
    expect(issues).toEqual([]);
    expect(steps).toMatchObject([{ id: "s1", check: null }]);
    expect(steps[0]?.body.map((b) => b.type)).toEqual(["paragraph"]);
  });

  it("attributes block issues to their step", () => {
    const { steps, issues } = parseLesson(
      step("Broken drawing", "```diagram\n---\nflowchart TB\n  A\n```"),
    );
    expect(steps).toEqual([]);
    expect(issues).toMatchObject([
      { code: "diagram/missing-caption", stepId: "s1", blockId: "s1.b2" },
    ]);
  });

  it("reports an empty lesson", () => {
    expect(parseLesson("   ").issues.map((i) => i.code)).toEqual(["lesson/empty"]);
  });
});

describe("splitLessonSteps", () => {
  it("cuts a lesson at its top-level ## headings, never inside code", () => {
    const lesson = "## One\n\nText.\n\n```md\n## not a step\n```\n\n## Two\n\nMore.";
    expect(splitLessonSteps(lesson)).toEqual([
      "## One\n\nText.\n\n```md\n## not a step\n```",
      "## Two\n\nMore.",
    ]);
  });

  it("returns nothing before the first step", () => {
    expect(splitLessonSteps("Intro only.")).toEqual([]);
  });
});

describe("parseLesson: numbering", () => {
  it("numbers steps from firstStepNumber", () => {
    const { steps } = parseLesson(step("Three", "Body."), { firstStepNumber: 3 });
    expect(steps[0]?.id).toBe("s3");
    expect(steps[0]?.check?.id).toBe("s3.b3");
  });
});

describe("parseLesson: tolerated issues", () => {
  it("keeps a step whose issues are all tolerated, without the broken blocks", () => {
    const markdown = step("Drawing", "Text.\n\n```diagram\nno caption\n```");
    expect(parseLesson(markdown).steps).toEqual([]);
    const { steps, issues } = parseLesson(markdown, {
      tolerate: (issue) => issue.code.startsWith("diagram/"),
    });
    expect(steps[0]?.body.map((b) => b.type)).toEqual(["paragraph"]);
    expect(issues.map((i) => i.code)).toEqual(["diagram/missing-separator"]);
  });
});
