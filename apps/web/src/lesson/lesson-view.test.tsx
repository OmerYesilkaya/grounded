import { parseBlocks, parseLesson, type LessonStep } from "@grounded/content";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LessonView, type LessonViewProps, type StepProgress } from "./lesson-view";

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

const tutor = (markdown: string, verdict?: "landed" | "missed") => ({
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
beforeEach(() => {
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
});

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

    await user.type(input, "x = 5{Shift>}{Enter}{/Shift}y = 6");
    expect(input).toHaveValue("x = 5\ny = 6");
    expect(props.onAnswer).toHaveBeenCalledTimes(2);
    await user.type(input, "{Enter}");
    expect(props.onAnswer).toHaveBeenLastCalledWith("s1", "x = 5\ny = 6");
    expect(input).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "I don't know" }));
    expect(props.onDontKnow).toHaveBeenCalledWith("s1");
  });

  it("shows the repair thread and keeps the input for the fresh question", () => {
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
    expect(within(check).getByText("they collided")).toBeInTheDocument();
    expect(within(check).getByText("Not quite there yet")).toBeInTheDocument();
    expect(within(check).getByText("before")).toBeInTheDocument();
    expect(
      within(check).getByText("Try this one: what is the worst final balance?"),
    ).toBeInTheDocument();
    expect(within(check).getByRole("textbox", { name: "Your answer" })).toBeInTheDocument();
  });

  it("disables the input while an answer is being checked", () => {
    renderLesson({
      s1: { status: "open", thread: [{ from: "learner", text: "5" }], grading: true },
    });
    expect(screen.getByRole("textbox", { name: "Your answer" })).toBeDisabled();
    expect(screen.getByText("Checking your answer…")).toBeInTheDocument();
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
    const verdict = tutor("Close. Worker B copied **before** A put 6 back.", "missed");
    const update = renderRerenderable({ s1: { status: "open", thread: [answer], grading: true } });
    const box = screen.getByRole("textbox", { name: "Your answer" });
    box.blur();

    update({ s1: { status: "open", thread: [answer, verdict] } });
    expect(box).toHaveFocus();

    box.blur();
    update({
      s1: { status: "open", thread: [answer, verdict, tutor("What is the worst final balance?")] },
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
