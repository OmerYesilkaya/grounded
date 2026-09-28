import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assemblePrompt,
  assembleSystemPrompt,
  joinSystemPrompt,
  parseMethod,
  PHASES,
  type PromptContext,
} from "./index.js";

const FIXTURE = `<!--
  Header comment explaining the tags; never part of a prompt.
-->

<!-- phases: all -->
# Method

Always on.

<!-- phases: probe final -->
## Probe

Probe rules.

<!-- phases: lesson -->
## Lesson

Lesson rules.
`;

const context: PromptContext = {
  track: { title: "How software works", language: "English" },
  terms: [
    { term: "memory", status: "confirmed", restsOn: [] },
    { term: "race condition", status: "planned", restsOn: ["memory", "worker"] },
  ],
  borrowed: [{ term: "worker", fromTrack: "Operating systems" }],
  plan: {
    arcs: [{ title: "Concurrency", terms: ["race condition"] }],
    notes: "Reordered: backend first.",
  },
  fixList: [{ text: "Thinks adding one is a single step", status: "open" }],
  teachingNotes: ["Abstract ideas land after one concrete example first."],
};

describe("assemblePrompt", () => {
  const method = parseMethod(FIXTURE);

  it("includes exactly the sections tagged for the phase, never the header comment", () => {
    const probe = assemblePrompt(method, "probe", {});
    expect(probe).toContain("Always on.");
    expect(probe).toContain("Probe rules.");
    expect(probe).not.toContain("Lesson rules.");
    expect(probe).not.toContain("Header comment");
    expect(probe).not.toContain("<!--");

    const lesson = assemblePrompt(method, "lesson", {});
    expect(lesson).toContain("Lesson rules.");
    expect(lesson).not.toContain("Probe rules.");
  });

  it("appends the context the app provides, the same way every time", () => {
    const prompt = assemblePrompt(method, "probe", context);
    expect(prompt).toBe(assemblePrompt(method, "probe", context));
    expect(prompt.indexOf("Probe rules.")).toBeLessThan(
      prompt.indexOf("# What the app gives you in this call"),
    );
    expect(prompt).toContain("Subject: How software works\nTeaching language: English");
    expect(prompt).toContain("| memory | confirmed | — |");
    expect(prompt).toContain("| race condition | planned | memory, worker |");
    expect(prompt).toContain("- worker (confirmed in Operating systems)");
    expect(prompt).toContain("1. Concurrency: race condition");
    expect(prompt).toContain("Reordered: backend first.");
    expect(prompt).toContain("- [open] Thinks adding one is a single step");
    expect(prompt).toContain("- Abstract ideas land after one concrete example first.");
  });

  it("orders the prompt stable-first: method, then the track's state, then the call's own parts", () => {
    const prompt = assemblePrompt(method, "check", {
      ...context,
      extra: [{ heading: "The step being checked", body: "Step one." }],
    });
    const order = [
      "Always on.",
      "# What the app gives you in this call",
      "## Track",
      "## Plan",
      "## Term list",
      "## Borrowed terms",
      "## Fix-list",
      "## Teaching notes",
      "## The step being checked",
    ].map((heading) => prompt.indexOf(heading));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("keeps the prefix of two calls in the same track and phase byte-identical up to the call's own part", () => {
    const grading = assembleSystemPrompt(method, "check", {
      ...context,
      extra: [{ heading: "The step being checked", body: "Step one." }],
    });
    const next = assembleSystemPrompt(method, "check", {
      ...context,
      extra: [{ heading: "The step being checked", body: "Step two, with more to say." }],
    });
    expect(next.method).toBe(grading.method);
    expect(next.track).toBe(grading.track);
    expect(next.call).not.toBe(grading.call);

    const prefix = `${grading.method}\n\n${grading.track}\n\n`;
    expect(joinSystemPrompt(grading).startsWith(prefix)).toBe(true);
    expect(joinSystemPrompt(next).startsWith(prefix)).toBe(true);
    expect(joinSystemPrompt(grading).slice(prefix.length)).toBe(grading.call);
  });

  it("joins its parts into exactly the prompt, the context heading opening whichever part comes first", () => {
    const extra = [{ heading: "Research notes", body: "Notes." }];
    for (const ctx of [{}, context, { extra }, { ...context, extra }]) {
      const parts = assembleSystemPrompt(method, "plan", ctx);
      expect(joinSystemPrompt(parts)).toBe(assemblePrompt(method, "plan", ctx));
    }
    const callOnly = assembleSystemPrompt(method, "plan", { extra });
    expect(callOnly.track).toBe("");
    expect(callOnly.call).toBe(
      "# What the app gives you in this call\n\n## Research notes\n\nNotes.",
    );
    expect(assembleSystemPrompt(method, "plan", {})).toMatchObject({ track: "", call: "" });
  });

  it("leaves out context sections that weren't provided", () => {
    const prompt = assemblePrompt(method, "probe", {
      track: { title: "Music", language: "Turkish" },
    });
    expect(prompt).toContain("Teaching language: Turkish");
    expect(prompt).not.toContain("## Term list");
    expect(prompt).not.toContain("## Teaching notes");
  });

  it("rejects a method with an unknown phase in a tag", () => {
    expect(() => parseMethod("<!-- phases: probe dance -->\n# X")).toThrow(
      'Unknown phase "dance" in method.md.',
    );
  });
});

describe("the real method.md", () => {
  const method = parseMethod(readFileSync(new URL("../../../method.md", import.meta.url), "utf8"));

  it("gives every phase the two principles and the conduct rules", () => {
    for (const phase of PHASES) {
      const prompt = assemblePrompt(method, phase, {});
      expect(prompt, phase).toContain("## Principle i — Unconditional truths first");
      expect(prompt, phase).toContain("## Principle ii");
      expect(prompt, phase).toContain("## Conduct (always on)");
    }
  });

  it("keeps each phase's own rules to that phase", () => {
    expect(assemblePrompt(method, "probe", {})).toContain("A probe teaches nothing.");
    expect(assemblePrompt(method, "aside", {})).not.toContain("A probe teaches nothing.");
    expect(assemblePrompt(method, "aside", {})).toContain("## Asides — answering in the margin");
    expect(assemblePrompt(method, "lesson", {})).not.toContain(
      "## Asides — answering in the margin",
    );
    expect(assemblePrompt(method, "check", {})).toContain("### Checks inside the lesson");
    expect(assemblePrompt(method, "profile", {})).toContain("## Refreshing the teaching notes");
    expect(assemblePrompt(method, "lesson", {})).not.toContain("## Refreshing the teaching notes");
  });
});

describe("assemblePrompt: teaching language", () => {
  it("says when the track's language isn't known yet", () => {
    const method = parseMethod(FIXTURE);
    const prompt = assemblePrompt(method, "probe", {
      track: { title: "Geometry", language: null },
    });
    expect(prompt).toContain(
      "Teaching language: not known yet. Teach in the language the learner writes in, and record it with set-language.",
    );
  });
});
