import { parseBlocks, parseLesson, type LessonStep } from "@grounded/content";
import type { CheckOutcome } from "@grounded/core/check";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLanguage } from "@/i18n";
import { LessonView, type LessonViewProps, type StepProgress } from "./lesson-view";
import { verdictHold } from "./steps";

const LESSON = ["Adding one is three moves", "Two workers, one number", "Closing the gap"]
  .map(
    (title, i) =>
      `## ${title}\n\nBody of step ${String(i + 1)}.\n\n:::check\nQuestion ${String(i + 1)}?\n:::`,
  )
  .join("\n\n");

function steps(): LessonStep[] {
  const result = parseLesson(LESSON);
  expect(result.issues).toEqual([]);
  return result.steps;
}

const tutor = (markdown: string, verdict?: CheckOutcome) => ({
  from: "tutor" as const,
  blocks: parseBlocks(markdown).blocks,
  ...(verdict ? { verdict } : {}),
});

function renderLesson(
  progress: Record<string, StepProgress>,
  overrides: Partial<LessonViewProps> = {},
) {
  const props: LessonViewProps = {
    steps: steps(),
    totalSteps: 5,
    progress,
    onAnswer: vi.fn(),
    onDontKnow: vi.fn(),
    onPause: vi.fn(),
    onContinue: vi.fn(),
    ...overrides,
  };
  render(<LessonView {...props} />);
  return props;
}

const scrollIntoView = vi.fn();
const scrollTo = vi.fn();
beforeEach(() => {
  scrollIntoView.mockClear();
  scrollTo.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
  window.scrollTo = scrollTo;
});

/** Lays `element` out `top` pixels down the window (jsdom lays nothing out). */
function layOut(element: Element | null, top: number) {
  if (!element) throw new Error("expected an element to lay out");
  element.getBoundingClientRect = () => new DOMRect(0, top, 600, 100);
}

describe("LessonView: revealing steps", () => {
  it("shows steps up to the first open check, and how many are still to come", () => {
    renderLesson({ s1: { status: "passed", thread: [] } });

    const article = screen.getByRole("article");
    expect(
      within(article)
        .getAllByRole("heading", { level: 2 })
        .map((h) => h.textContent),
    ).toEqual(["Adding one is three moves", "Two workers, one number"]);
    expect(screen.queryByText("Closing the gap")).toBeNull();
    expect(
      screen.getByText("3 more steps · each opens when the check before it lands"),
    ).toBeInTheDocument();
  });

  it("opens a step without a check together with the step after it, and asks nothing on it", () => {
    const mixed = parseLesson(
      "## Background\n\nBody one.\n\n## Needs it\n\nBody two.\n\n:::check\nQuestion two?\n:::\n\n## Later\n\nBody three.",
    ).steps;
    renderLesson(
      { s1: { status: "unchecked", thread: [] }, s2: { status: "open", thread: [] } },
      { steps: mixed, totalSteps: 3 },
    );
    const article = screen.getByRole("article");
    expect(
      within(article)
        .getAllByRole("heading", { level: 2 })
        .map((h) => h.textContent),
    ).toEqual(["Background", "Needs it"]);
    expect(within(article).getAllByRole("textbox")).toHaveLength(1);
    expect(screen.getByText("Question two?")).toBeInTheDocument();
  });

  it("doesn't glide to a step that arrives under one without a check as it is written", () => {
    vi.useFakeTimers();
    try {
      const [first, second] = parseLesson(
        "## Background\n\nBody one.\n\n## Needs it\n\nBody two.\n\n:::check\nQuestion two?\n:::",
      ).steps;
      if (!first || !second) throw new Error("fixture lesson is short");
      const props: LessonViewProps = {
        steps: [first],
        totalSteps: 2,
        progress: { s1: { status: "unchecked", thread: [] } },
        onAnswer: vi.fn(),
        onDontKnow: vi.fn(),
        onPause: vi.fn(),
        onContinue: vi.fn(),
      };
      const { rerender } = render(<LessonView {...props} />);
      rerender(<LessonView {...props} steps={[first, second]} />);
      vi.advanceTimersByTime(2000);
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds a landed verdict alone on the page while it is read, then the next step arrives and the page glides to the verdict", () => {
    vi.useFakeTimers();
    try {
      const props: LessonViewProps = {
        steps: steps(),
        totalSteps: 5,
        progress: { s1: { status: "open", thread: [], grading: true } },
        onAnswer: vi.fn(),
        onDontKnow: vi.fn(),
        onPause: vi.fn(),
        onContinue: vi.fn(),
      };
      const { rerender } = render(<LessonView {...props} />);
      const words = "Yes — each works from a copy that is already out of date.";
      rerender(
        <LessonView
          {...props}
          progress={{ s1: { status: "passed", thread: [tutor(words, "landed")] } }}
        />,
      );
      expect(screen.getByText("That's it")).toBeInTheDocument();
      expect(screen.queryByText("Two workers, one number")).toBeNull();
      expect(
        screen.getByText("4 more steps · each opens when the check before it lands"),
      ).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(verdictHold(words) - 1);
      });
      expect(screen.queryByText("Two workers, one number")).toBeNull();
      expect(scrollTo).not.toHaveBeenCalled();

      layOut(document.querySelector('[data-verdict="landed"]'), 700);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      const heading = screen.getByRole("heading", { level: 2, name: "Two workers, one number" });
      expect(heading.closest("section")).toHaveClass("motion-safe:animate-arrive");
      // The glide stops with the verdict at the top of the window.
      expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 700, behavior: "smooth" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the steps the page opens with at once, without a glide", () => {
    renderLesson({ s1: { status: "passed", thread: [tutor("Yes.", "landed")] } });
    const heading = screen.getByRole("heading", { level: 2, name: "Two workers, one number" });
    expect(heading.closest("section")).not.toHaveClass("motion-safe:animate-arrive");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("continues past a step left settling, and marks it", () => {
    renderLesson({ s1: { status: "settling", thread: [] } });
    expect(
      screen.getByRole("heading", { level: 2, name: "Two workers, one number" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Still settling")).toBeInTheDocument();
  });

  it("shows the note added under a step after its check", () => {
    renderLesson({
      s1: { status: "passed", thread: [], note: "The copy is stale, not colliding." },
    });
    expect(screen.getByText("After the check")).toBeInTheDocument();
    expect(screen.getByText("The copy is stale, not colliding.")).toBeInTheDocument();
  });
});

describe("LessonView: answering a check", () => {
  it("sends the answer, by button or Enter, and 'I don't know'", async () => {
    const user = userEvent.setup();
    const props = renderLesson({});
    const input = screen.getByRole("textbox", { name: "Your answer" });

    expect(screen.getByRole("button", { name: "Answer" })).toBeDisabled();
    await user.type(input, "memory still holds 5");
    await user.click(screen.getByRole("button", { name: "Answer" }));
    expect(props.onAnswer).toHaveBeenCalledWith("s1", "memory still holds 5");

    await user.type(input, "again{Enter}");
    expect(props.onAnswer).toHaveBeenLastCalledWith("s1", "again");

    await user.type(input, "x = 5{Shift>}{Enter}{/Shift}y = `6`");
    expect(input.querySelector("br")).not.toBeNull();
    expect(props.onAnswer).toHaveBeenCalledTimes(2);
    await user.type(input, "{Enter}");
    // Sent as markdown: the line break, and the code typed as code.
    expect(props.onAnswer).toHaveBeenLastCalledWith("s1", "x = 5\ny = `6`");
    expect(input).toHaveTextContent("");

    await user.click(screen.getByRole("button", { name: "I don't know" }));
    expect(props.onDontKnow).toHaveBeenCalledWith("s1");
  });

  it("shows the repair and the fresh question as one turn, and keeps the input for it", () => {
    renderLesson({
      s1: {
        status: "open",
        thread: [
          { from: "learner", text: "they collided" },
          tutor(
            "Close. Worker B copied **before** A put 6 back.\n\nTry this one: what is the worst final balance?",
            "missed",
          ),
        ],
      },
    });
    const check = screen.getByRole("group", { name: "Check" });
    expect(within(check).getByText("they collided")).toBeInTheDocument();
    expect(within(check).getAllByText("Tutor")).toHaveLength(1);
    expect(within(check).getByText("Not quite there yet")).toBeInTheDocument();
    expect(within(check).getByText("before")).toBeInTheDocument();
    expect(
      within(check).getByText("Try this one: what is the worst final balance?"),
    ).toBeInTheDocument();
    expect(within(check).getByRole("textbox", { name: "Your answer" })).toBeInTheDocument();
  });

  it("shows a thread stored with the fresh question on its own as it is", () => {
    renderLesson({
      s1: {
        status: "open",
        thread: [
          { from: "learner", text: "they collided" },
          tutor("Close. Worker B copied **before** A put 6 back.", "missed"),
          tutor("Try this one: what is the worst final balance?"),
        ],
      },
    });
    const check = screen.getByRole("group", { name: "Check" });
    expect(within(check).getAllByText("Tutor")).toHaveLength(2);
    expect(within(check).getAllByText("Not quite there yet")).toHaveLength(1);
    expect(
      within(check).getByText("Try this one: what is the worst final balance?"),
    ).toBeInTheDocument();
  });

  it("disables the input while an answer is being checked", () => {
    renderLesson({
      s1: { status: "open", thread: [{ from: "learner", text: "5" }], grading: true },
    });
    expect(screen.getByRole("textbox", { name: "Your answer" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByText("Checking your answer…")).toHaveClass("text-shimmer");
  });

  it("stops shimmering once the verdict is in", () => {
    renderLesson({
      s1: {
        status: "open",
        thread: [{ from: "learner", text: "5" }, tutor("Close.", "missed")],
      },
    });
    expect(screen.queryByText("Checking your answer…")).toBeNull();
    expect(screen.getByText("Not quite there yet")).not.toHaveClass("text-shimmer");
  });

  it("offers pausing or continuing when the idea is still shaky", async () => {
    const user = userEvent.setup();
    const props = renderLesson({ s1: { status: "open", thread: [], offerGate: true } });

    expect(screen.queryByRole("textbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: /Pause here/ }));
    expect(props.onPause).toHaveBeenCalledWith("s1");
    await user.click(screen.getByRole("button", { name: "Continue anyway" }));
    expect(props.onContinue).toHaveBeenCalledWith("s1");
  });

  it("stops at a paused step and says what happens next", () => {
    renderLesson({ s1: { status: "paused", thread: [] } });
    expect(screen.queryByText("Two workers, one number")).toBeNull();
    expect(
      screen.getByText("Paused here. Next time starts with a fresh question on this idea."),
    ).toBeInTheDocument();
  });

  it("shows a landed check as done, without an input", () => {
    renderLesson({
      s1: {
        status: "passed",
        thread: [{ from: "learner", text: "5" }, tutor("That's it.", "landed")],
      },
    });
    const [first] = screen.getAllByRole("group", { name: "Check" });
    if (!first) throw new Error("expected a check");
    expect(within(first).getByText("That's it")).toBeInTheDocument();
    expect(within(first).queryByRole("textbox")).toBeNull();
  });
});

describe("LessonView: focusing a check", () => {
  function renderRerenderable(progress: Record<string, StepProgress>) {
    const props: LessonViewProps = {
      steps: steps(),
      totalSteps: 3,
      progress,
      onAnswer: vi.fn(),
      onDontKnow: vi.fn(),
      onPause: vi.fn(),
      onContinue: vi.fn(),
    };
    const { rerender } = render(<LessonView {...props} />);
    return (next: Record<string, StepProgress>) => {
      rerender(<LessonView {...props} progress={next} />);
    };
  }

  it("focuses the check's answer box when the check is answerable", () => {
    renderRerenderable({});
    expect(screen.getByRole("textbox", { name: "Your answer" })).toHaveFocus();
  });

  it("focuses it again when a repair's fresh question arrives", () => {
    const answer = { from: "learner" as const, text: "they collided" };
    const verdict = tutor(
      "Close. Worker B copied **before** A put 6 back.\n\nWhat is the worst final balance?",
      "missed",
    );
    const update = renderRerenderable({ s1: { status: "open", thread: [answer], grading: true } });
    const box = screen.getByRole("textbox", { name: "Your answer" });
    box.blur();

    update({ s1: { status: "open", thread: [answer, verdict] } });
    expect(box).toHaveFocus();

    // Back after a pause, the fresh question comes on its own.
    box.blur();
    update({
      s1: { status: "open", thread: [answer, verdict, tutor("What does memory hold meanwhile?")] },
    });
    expect(box).toHaveFocus();
  });

  it("focuses the next step's check once the gate is passed", async () => {
    const user = userEvent.setup();
    const update = renderRerenderable({ s1: { status: "open", thread: [], offerGate: true } });
    await user.click(screen.getByRole("button", { name: "Continue anyway" }));

    update({ s1: { status: "settling", thread: [] } });
    const [, second] = screen.getAllByRole("group", { name: "Check" });
    if (!second) throw new Error("expected a second check");
    expect(within(second).getByRole("textbox", { name: "Your answer" })).toHaveFocus();
    // Continued past: the step arrives at once, and the page glides to its heading.
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: "smooth" });
  });
});

describe("LessonView: step timeline", () => {
  it("lists unlocked steps by name and hides the names of locked ones", async () => {
    const user = userEvent.setup();
    renderLesson({ s1: { status: "passed", thread: [] } });
    const nav = screen.getByRole("navigation", { name: "Lesson steps" });

    const unlocked = within(nav)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(unlocked).toEqual(["Adding one is three moves", "Two workers, one number"]);
    expect(within(nav).getAllByLabelText("Locked step")).toHaveLength(3);

    await user.click(within(nav).getByRole("button", { name: "Two workers, one number" }));
    expect(scrollIntoView).toHaveBeenCalled();
  });
});

describe("LessonView: sources", () => {
  /** The lesson's steps, with the server's sources given to their citations as it verified them. */
  function citing(
    sources = [
      { url: "https://example.org/rmw", title: "Read-modify-write" },
      { url: "https://example.org/races", title: "example.org" },
    ],
  ): LessonStep[] {
    const markdown = LESSON.replace("Body of step 1.", "Body of step 1:cite[2]:cite[1].").replace(
      "Body of step 2.",
      "Body of step 2:cite[2].",
    );
    const result = parseLesson(markdown);
    expect(result.issues).toEqual([]);
    const resolve = (block: LessonStep["body"][number]): LessonStep["body"][number] =>
      block.type === "paragraph"
        ? {
            ...block,
            children: block.children.map((inline) =>
              inline.type === "cite"
                ? { ...inline, source: sources[inline.ref - 1] ?? null }
                : inline,
            ),
          }
        : block;
    return result.steps.map((step) => ({ ...step, body: step.body.map(resolve) }));
  }

  it("numbers the sources the steps shown cite, in the order they are first cited, each mark linked to its place in the list", () => {
    renderLesson({ s1: { status: "passed", thread: [] } }, { steps: citing() });
    const list = screen.getByRole("region", { name: "Sources" });
    const entries = within(list).getAllByRole("listitem");
    expect(entries.map((e) => e.textContent)).toEqual([
      "example.org",
      "Read-modify-write · example.org",
    ]);
    expect(within(list).getByRole("link", { name: "Read-modify-write" })).toHaveAttribute(
      "href",
      "https://example.org/rmw",
    );
    const marks = screen.getAllByRole("link", { name: /^\[\d\]$/ });
    expect(marks.map((m) => [m.textContent, m.getAttribute("href")])).toEqual([
      ["[1]", "#lesson-source-1"],
      ["[2]", "#lesson-source-2"],
      ["[1]", "#lesson-source-1"],
    ]);
    expect(
      within(list).getByText(/What has no numbered source comes from the tutor's own knowledge/),
    ).toBeInTheDocument();
  });

  it("names a section of the track's own source as it is, linked to the learner's file in the app", () => {
    const book = {
      url: "/api/tracks/t1/files/f1#page=12",
      title: 'Networks from the Ground Up, "Packets", pp. 2–3',
    };
    renderLesson({ s1: { status: "passed", thread: [] } }, { steps: citing([book, book]) });
    const list = screen.getByRole("region", { name: "Sources" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((e) => e.textContent),
    ).toEqual([book.title]);
    const link = within(list).getByRole("link", { name: book.title });
    expect(link).toHaveAttribute("href", book.url);
    expect(link).not.toHaveAttribute("target");
  });

  it("says what an uncited lesson rests on, with no list", () => {
    renderLesson({});
    const sources = screen.getByRole("region", { name: "Sources" });
    expect(within(sources).queryByRole("list")).toBeNull();
    expect(sources).toHaveTextContent("comes from the tutor's own knowledge");
  });
});

describe("LessonView: in Turkish", () => {
  afterEach(() => {
    act(() => {
      setLanguage("en");
    });
    localStorage.clear();
  });

  it("says its own words in the app's language, and leaves the lesson's as written", () => {
    act(() => {
      setLanguage("tr");
    });
    renderLesson({
      s1: { status: "settling", thread: [tutor("Close, but not the whole of it.", "missed")] },
      s2: { status: "open", thread: [], offerGate: true },
    });
    expect(screen.getByText("Henüz oturuyor")).toBeInTheDocument();
    expect(screen.getByText("Henüz tam değil")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Yine de devam et" })).toBeInTheDocument();
    expect(
      screen.getByText("3 adım daha · her biri, önceki kontrol sorusunu geçince açılır"),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Adding one is three moves" })).toBeInTheDocument();
  });
});
