import { parseBlocks, parseLesson } from "@grounded/content";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { reduceAsides } from "@/lib/asides";
import { LessonView, type Aside, type LessonAsides } from "./lesson-view";

const STEPS = parseLesson(
  "## Adding one is three moves\n\nThe value is copied out, changed, and put back.\n\n:::check\nWhat is in memory meanwhile?\n:::",
).steps;

const ANCHOR = {
  blockId: "s1.b2",
  quote: "copied out",
  prefix: "The value is ",
  suffix: ", changed",
};

const answered = (overrides: Partial<Aside> = {}): Aside => ({
  id: "a1",
  stepId: "s1",
  anchor: ANCHOR,
  draft: null,
  tangent: null,
  saved: false,
  messages: [
    { id: "m1", role: "learner", text: "Copied out to where?", blocks: null },
    {
      id: "m2",
      role: "tutor",
      text: null,
      blocks: parseBlocks("It stays in memory; a **copy** is changed.").blocks,
    },
  ],
  ...overrides,
});

function renderAsides(overrides: Partial<LessonAsides> = {}) {
  const asides: LessonAsides = {
    items: [],
    hint: true,
    canAsk: true,
    onAsk: vi.fn(() => Promise.resolve("a1")),
    onFollowUp: vi.fn(() => Promise.resolve()),
    onSave: vi.fn(),
    ...overrides,
  };
  const props = {
    steps: STEPS,
    totalSteps: 1,
    progress: {},
    onAnswer: vi.fn(),
    onDontKnow: vi.fn(),
    onPause: vi.fn(),
    onContinue: vi.fn(),
  };
  const view = render(<LessonView {...props} asides={asides} />);
  return {
    asides,
    rerender: (next: Partial<LessonAsides>) => {
      view.rerender(<LessonView {...props} asides={{ ...asides, ...next }} />);
    },
  };
}

/** Selects part of the passage's text, as the learner would, and lets the page hear of it. */
function select(start: number, end: number) {
  const node = document.querySelector('[data-block="s1.b2"]')?.firstChild;
  if (!node) throw new Error("no passage");
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  act(() => {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

describe("LessonView: asking in the margin", () => {
  it("shows how to ask until the learner first has", () => {
    const { rerender } = renderAsides();
    expect(screen.getByText(/Select any passage and ask about it/)).toBeInTheDocument();
    rerender({ hint: false });
    expect(screen.queryByText(/Select any passage and ask about it/)).toBeNull();
  });

  it("asks about the selected passage, and the card takes the question's place", async () => {
    const user = userEvent.setup();
    const { asides, rerender } = renderAsides();
    select(13, 23);
    await user.click(screen.getByRole("button", { name: "Ask about this" }));
    const box = screen.getByRole("textbox", { name: "Your question about this passage" });
    expect(box).toHaveFocus();
    expect(screen.queryByText(/Select any passage and ask about it/)).toBeNull();

    await user.type(box, "Copied out to where?{Enter}");
    expect(asides.onAsk).toHaveBeenCalledWith(
      expect.objectContaining({ blockId: "s1.b2", quote: "copied out" }),
      "Copied out to where?",
    );
    // Until its card arrives, the question waits in the margin.
    expect(await screen.findByText("Thinking…")).toBeInTheDocument();

    rerender({
      items: [{ ...answered(), messages: answered().messages.slice(0, 1), draft: "It st" }],
    });
    const card = screen.getByRole("group", { name: "Question on “copied out”" });
    expect(within(card).getByText("Copied out to where?")).toBeInTheDocument();
    expect(within(card).getByRole("textbox", { name: "Follow up" })).toBeInTheDocument();
  });

  it("takes no question on a closed session", () => {
    renderAsides({ canAsk: false, items: [answered()] });
    select(13, 23);
    expect(screen.queryByRole("button", { name: "Ask about this" })).toBeNull();
    expect(screen.queryByText(/Select any passage and ask about it/)).toBeNull();
    const card = screen.getByRole("group", { name: "Question on “copied out”" });
    expect(within(card).getByText("Copied out to where?")).toBeInTheDocument();
  });

  it("opens a card to follow up, and saves a tangent it offers", async () => {
    const user = userEvent.setup();
    const { asides } = renderAsides({
      hint: false,
      items: [answered({ tangent: "How databases avoid lost updates" })],
    });
    const card = screen.getByRole("group", { name: "Question on “copied out”" });
    // Closed, it shows the question and the start of the answer.
    expect(within(card).queryByRole("textbox")).toBeNull();
    await user.click(card);
    await user.type(within(card).getByRole("textbox", { name: "Follow up" }), "And then?{Enter}");
    expect(asides.onFollowUp).toHaveBeenCalledWith("a1", "And then?");
    await user.click(within(card).getByRole("button", { name: "Save for a future session" }));
    expect(asides.onSave).toHaveBeenCalledWith("a1");

    await user.keyboard("{Escape}");
    expect(within(card).queryByRole("textbox")).toBeNull();
  });
});

describe("the session's asides", () => {
  const event = (asides: Aside[], type: string, data: object) => {
    const next = reduceAsides(asides, type, data);
    if (!next) throw new Error(`${type} isn't an aside event`);
    return next;
  };

  it("stream an answer into its aside, which keeps the streamed text", () => {
    let asides = event([], "aside", { id: "a1", stepId: "s1", anchor: ANCHOR });
    asides = event(asides, "aside-message", {
      id: "m1",
      asideId: "a1",
      role: "learner",
      text: "Where?",
      blocks: null,
    });
    asides = event(asides, "aside-delta", { asideId: "a1", replyTo: "m1", text: "It " });
    asides = event(asides, "aside-delta", { asideId: "a1", replyTo: "m1", text: "stays." });
    // A piece replying to another question is not this answer's.
    asides = event(asides, "aside-delta", { asideId: "a1", replyTo: "old", text: "x" });
    expect(asides[0]?.draft).toBe("It stays.");
    const blocks = parseBlocks("It stays.").blocks;
    asides = event(asides, "aside-message", {
      id: "m2",
      asideId: "a1",
      role: "tutor",
      text: null,
      blocks,
    });
    // Replayed, nothing doubles.
    asides = event(asides, "aside-message", { id: "m2", asideId: "a1", role: "tutor", blocks });
    expect(asides[0]?.messages.map((m) => [m.role, m.text])).toEqual([
      ["learner", "Where?"],
      ["tutor", "It stays."],
    ]);
    expect(asides[0]?.draft).toBeNull();

    asides = event(asides, "aside-tangent", { asideId: "a1", tangent: "Databases" });
    asides = event(asides, "aside-saved", { asideId: "a1" });
    expect(asides[0]).toMatchObject({ tangent: "Databases", saved: true });
    expect(reduceAsides(asides, "message-delta", {})).toBeNull();
  });
});
