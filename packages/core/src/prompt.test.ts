import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assemblePrompt,
  assembleSystemPrompt,
  chapterList,
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

const SOURCE: NonNullable<PromptContext["source"]> = {
  files: ["networks.pdf", "lecture-notes.md"],
  chapters: [
    {
      n: 1,
      file: "networks.pdf",
      title: "Packets",
      part: "Part I: Moving bytes",
      pages: "pp. 2–30",
      summary: "What a packet is.",
      assumes: "Binary numbers.",
    },
    {
      n: 2,
      file: "networks.pdf",
      title: "Routing",
      part: "Part I: Moving bytes",
      pages: "pp. 31–60",
      summary: null,
      assumes: null,
    },
    {
      n: 3,
      file: "lecture-notes.md",
      title: "Week 1",
      part: null,
      pages: null,
      summary: "Sockets.",
      assumes: "",
    },
  ],
  readThrough: 1,
  assigned: 2,
  session: [2],
};

describe("a source track's prompt", () => {
  it("carries the source's chapters by file and part, how far the learner has read, and the session's chapter", () => {
    const prompt = assembleSystemPrompt(parseMethod(FIXTURE), "plan", { source: SOURCE });
    expect(prompt.track).toContain(
      [
        "## The source",
        "",
        "The learner chose to learn from these sources: networks.pdf, lecture-notes.md. They read it themselves, a chapter at a time, in their own copy. Its chapters, numbered across them:",
        "",
        "### networks.pdf",
        "",
        "Part I: Moving bytes:",
        "- Chapter 1 Packets (pp. 2–30): What a packet is. Expects the reader to know: Binary numbers.",
        "- Chapter 2 Routing (pp. 31–60)",
        "",
        "### lecture-notes.md",
        "",
        "- Chapter 3 Week 1: Sockets.",
        "",
        "Reading:",
        "",
        "- They have finished reading through Chapter 1.",
        "- Asked to read next: Chapter 2.",
        "- This session is about Chapter 2: the probe asks about it, and a lesson teaches only what the learner missed there.",
      ].join("\n"),
    );
  });

  it("names a run of chapters as one", () => {
    expect(chapterList([])).toBe("");
    expect(chapterList([4])).toBe("Chapter 4");
    expect(chapterList([4, 5, 6])).toBe("Chapters 4–6");
    expect(chapterList([4, 6])).toBe("Chapters 4, 6");
  });

  it("rejects a section for tracks the method doesn't know", () => {
    expect(() => parseMethod("<!-- phases: probe; tracks: imported -->\n# X")).toThrow(
      'Unknown tracks "imported" in method.md.',
    );
  });
});

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
    expect(prompt).toContain("| race condition | planned | memory · worker |");
    expect(prompt).toContain("- worker (confirmed in Operating systems)");
    expect(prompt).toContain("1. Concurrency: race condition");
    expect(prompt).toContain("Reordered: backend first.");
    expect(prompt).toContain("- [open] Thinks adding one is a single step");
    expect(prompt).toContain("- Abstract ideas land after one concrete example first.");
  });

  it("names a borrowed term's other name, and lists what other tracks hold for the plan", () => {
    const prompt = assemblePrompt(method, "plan", {
      borrowed: [{ term: "iş parçacığı", fromTrack: "Operating systems", as: "thread" }],
      heldElsewhere: [{ track: "Operating systems", terms: ["process", "thread"] }],
    });
    expect(prompt).toContain('- iş parçacığı (confirmed in Operating systems, as "thread")');
    expect(prompt).toContain(
      "## Held in the learner's other tracks\n\nWhere this track's path needs one of these ideas",
    );
    expect(prompt).toContain("### Operating systems\n\nprocess · thread");
  });

  it("sets term names apart, so one that holds commas reads as one term", () => {
    const long = "index; B-tree (pages → rows); measured 4 levels at 10M, 5 pages per lookup";
    const prompt = assemblePrompt(method, "lesson", {
      terms: [
        { term: long, status: "confirmed", restsOn: [] },
        { term: "a | b", status: "planned", restsOn: [long, "memory"] },
      ],
      plan: { arcs: [{ title: "Storage", terms: [long, "a | b"] }], notes: "" },
    });
    expect(prompt).toContain(`| a \\| b | planned | ${long} · memory |`);
    expect(prompt).toContain(`1. Storage: ${long} · a | b`);
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
    expect(next.sharedMethod).toBe(grading.sharedMethod);
    expect(next.phaseMethod).toBe(grading.phaseMethod);
    expect(next.track).toBe(grading.track);
    expect(next.call).not.toBe(grading.call);

    const prefix = `${joinSystemPrompt({ ...grading, call: "" })}\n\n`;
    expect(joinSystemPrompt(grading).startsWith(prefix)).toBe(true);
    expect(joinSystemPrompt(next).startsWith(prefix)).toBe(true);
    expect(joinSystemPrompt(grading).slice(prefix.length)).toBe(grading.call);
  });

  it("splits the method into the leading all-phase sections and the phase's own, in the document's order", () => {
    const later = parseMethod(`${FIXTURE}\n<!-- phases: all -->\n## Late\n\nAlso always on.\n`);
    const probe = assembleSystemPrompt(later, "probe", {});
    const lesson = assembleSystemPrompt(later, "lesson", {});
    expect(probe.sharedMethod).toBe("# Method\n\nAlways on.");
    expect(lesson.sharedMethod).toBe(probe.sharedMethod);
    // An `all` section after a phase's own stays where the document puts it.
    expect(probe.phaseMethod).toBe("## Probe\n\nProbe rules.\n\n## Late\n\nAlso always on.");
    expect(lesson.phaseMethod).toBe("## Lesson\n\nLesson rules.\n\n## Late\n\nAlso always on.");
    expect(assembleSystemPrompt(method, "check", {})).toMatchObject({
      sharedMethod: "# Method\n\nAlways on.",
      phaseMethod: "",
    });
  });

  it("marks the current arc and the closed ones, tallies arcs shown without their terms, and counts terms not listed", () => {
    const prompt = assemblePrompt(method, "probe", {
      plan: {
        arcs: [
          {
            title: "Memory",
            terms: ["bit", "memory"],
            tally: { confirmed: 1, assumed: 1 },
            closed: true,
          },
          { title: "Concurrency", terms: ["race condition"], current: true },
          { title: "Networks", terms: ["packet", "TCP", "QUIC"], tally: { planned: 3 } },
        ],
      },
      terms: [{ term: "race condition", status: "planned", restsOn: [] }],
      termsNotListed: { confirmed: 97, planned: 30 },
    });
    expect(prompt).toContain(
      [
        "1. Memory (closed: its arc exam is set): 2 terms (1 confirmed, 1 assumed)",
        "2. Concurrency (the current arc): race condition",
        "3. Networks: 3 terms (3 planned)",
      ].join("\n"),
    );
    expect(prompt).toContain(
      "| race condition | planned | — |\n\nNot listed here: 127 more terms of this track (30 planned, 97 confirmed), away from the current arc and from what recent sessions touched. Don't use them as known terms.",
    );
  });

  it("gives what the learner brought in the track's part, after the subject", () => {
    const prompt = assembleSystemPrompt(method, "lesson", {
      track: { title: "Backend interviews", language: "English" },
      brought: { files: ["cv.pdf", "notes.docx"], summary: "A CV: four years of Node.js APIs." },
      plan: { arcs: [] },
    });
    expect(prompt.track).toContain(
      [
        "Teaching language: English",
        "",
        "## What the learner brought",
        "",
        "Files they attached when they started the track: cv.pdf, notes.docx.",
        "",
        "A CV: four years of Node.js APIs.",
        "",
        "## Plan",
      ].join("\n"),
    );
    const unread = assemblePrompt(method, "lesson", {
      brought: { files: ["cv.pdf"], summary: null },
    });
    expect(unread).toContain(
      "cv.pdf.\n\n(Not summarized: what is in them isn't known in this call.)",
    );
  });

  it("gives the session's changes in the call's part, so the track's part stays the same", () => {
    const changes = {
      terms: [{ term: "memory", status: "taught" as const, restsOn: [] }],
      fixList: [{ text: "Thinks a lock is free", status: "open" as const }],
    };
    const before = assembleSystemPrompt(method, "probe", context);
    const after = assembleSystemPrompt(method, "probe", {
      ...context,
      changes,
      extra: [{ heading: "Research notes", body: "Notes." }],
    });
    expect(after.track).toBe(before.track);
    expect(after.call).toBe(
      [
        "## Changed since this session began",
        "",
        "Newer than the term list and fix-list above: where they differ, these hold.",
        "",
        "| term | status | rests on |",
        "| --- | --- | --- |",
        "| memory | taught | — |",
        "",
        "- [open] Thinks a lock is free",
        "",
        "## Research notes",
        "",
        "Notes.",
      ].join("\n"),
    );
    expect(
      assembleSystemPrompt(method, "probe", { ...context, changes: { terms: [], fixList: [] } }),
    ).toEqual(before);
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

  it("versions a method by its text: any change to it is a new version", () => {
    const method = parseMethod(FIXTURE);
    expect(method.version).toMatch(/^[0-9a-f]{12}$/);
    expect(parseMethod(FIXTURE).version).toBe(method.version);
    expect(parseMethod(`${FIXTURE} `).version).not.toBe(method.version);
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

  it("starts every phase's prompt with the same all-phase sections, so phases share them from the cache", () => {
    const shared = assembleSystemPrompt(method, "probe", context).sharedMethod;
    expect(shared).toContain("## Principle i — Unconditional truths first");
    expect(shared).toContain("## Conduct (always on)");
    for (const phase of PHASES) {
      const prompt = assembleSystemPrompt(method, phase, context);
      expect(prompt.sharedMethod, phase).toBe(shared);
      expect(prompt.phaseMethod, phase).not.toBe("");
      expect(joinSystemPrompt(prompt).startsWith(`${shared}\n\n${prompt.phaseMethod}\n\n`)).toBe(
        true,
      );
    }
    // Two different phases' prompts: the same bytes through the shared sections, then their own.
    const aside = assemblePrompt(method, "aside", context);
    const lesson = assemblePrompt(method, "lesson", context);
    expect(aside.slice(0, shared.length)).toBe(lesson.slice(0, shared.length));
    expect(aside.slice(shared.length)).toMatch(/^\n\n## Asides — answering in the margin\n/);
    expect(lesson.slice(shared.length)).toMatch(/^\n\n### The learner's teaching notes\n/);
  });

  it("keeps every all-phase section in the shared part, and every phase's sections in the document's order", () => {
    const always = method.sections.filter((s) => s.phases.includes("all"));
    for (const phase of PHASES) {
      const prompt = assembleSystemPrompt(method, phase, {});
      expect(prompt.sharedMethod, phase).toBe(always.map((s) => s.text).join("\n\n"));
      expect(joinSystemPrompt(prompt), phase).toBe(
        method.sections
          .filter((s) => s.phases.includes("all") || s.phases.includes(phase))
          .filter((s) => s.tracks === undefined)
          .map((s) => s.text)
          .join("\n\n"),
      );
    }
  });

  it("gives the rules for a source track only to a source track's calls", () => {
    const heading = "## Tracks taught from a source";
    expect(assemblePrompt(method, "probe", context)).not.toContain(heading);
    for (const phase of ["probe", "plan", "lesson", "check", "homework", "review"] as const)
      expect(assemblePrompt(method, phase, { ...context, source: SOURCE }), phase).toContain(
        heading,
      );
    expect(assemblePrompt(method, "profile", { ...context, source: SOURCE })).not.toContain(
      heading,
    );
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
