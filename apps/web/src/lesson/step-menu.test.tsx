import { parseLesson } from "@grounded/content";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StepMenu } from "./step-menu";
import type { Aside } from "./types";

const { steps } = parseLesson(
  ["Adding one is three moves", "Two workers, one number", "Closing the gap"]
    .map((title) => `## ${title}\n\nBody.\n\n:::check\nWhy?\n:::`)
    .join("\n\n"),
);

const aside = (id: string, stepId: string): Aside => ({
  id,
  stepId,
  anchor: { blockId: `${stepId}.b2`, quote: "Body", prefix: "", suffix: "" },
  messages: [],
  draft: null,
  tangent: null,
  saved: false,
});

const scrollIntoView = vi.fn();
beforeEach(() => {
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
});

describe("StepMenu", () => {
  it("says where the reader is, lists the open steps with their questions, and jumps", async () => {
    const user = userEvent.setup();
    render(
      <>
        {steps.map((step) => (
          <section key={step.id} id={`step-${step.id}`} />
        ))}
        <StepMenu
          steps={steps}
          totalSteps={5}
          progress={{ s1: { status: "passed", thread: [] }, s2: { status: "open", thread: [] } }}
          asides={[aside("a1", "s2"), aside("a2", "s2"), aside("a3", "s1")]}
        />
      </>,
    );

    // With no layout, every step's top is past the top of the window: the reader is at the last.
    const trigger = screen.getByRole("button", { name: /Step 2 of 5/ });
    await user.click(trigger);
    const menu = within(screen.getByRole("menu"));
    const items = menu.getAllByRole("menuitem");
    // Two open steps, and three locked ones that don't give their headings away.
    expect(items.map((item) => item.textContent)).toEqual([
      "1Adding one is three moves1 question",
      "2Two workers, one number2 questions",
      "3·····",
      "4·····",
      "5·····",
    ]);
    expect(items[1]).toHaveAttribute("aria-current", "step");
    expect(items[2]).toHaveAttribute("aria-disabled", "true");

    await user.click(menu.getByRole("menuitem", { name: /Adding one/ }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(document.getElementById("step-s1"));
  });
});
