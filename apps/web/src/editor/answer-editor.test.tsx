import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AnswerEditor } from "./answer-editor";

describe("AnswerEditor", () => {
  it("starts from markdown and gives markdown back as the learner writes", async () => {
    const onChange = vi.fn();
    render(
      <AnswerEditor initial={"Two **workers**, $x^2$."} onChange={onChange} label="Your answer" />,
    );
    const box = screen.getByRole("textbox", { name: "Your answer" });
    expect(box.querySelector("strong")?.textContent).toBe("workers");
    expect(box.querySelector("[data-type=inline-math]")?.getAttribute("data-latex")).toBe("x^2");
    await userEvent.setup().type(box, " More");
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining("More"));
    });
    expect(onChange.mock.lastCall?.[0]).toContain("**workers**");
    expect(onChange.mock.lastCall?.[0]).toContain("$x^2$");
  });

  it("renders `$…$` as maths once its closing dollar is typed, and leaves money alone", async () => {
    const onChange = vi.fn();
    render(<AnswerEditor initial="" onChange={onChange} label="Your answer" />);
    const box = screen.getByRole("textbox", { name: "Your answer" });
    const user = userEvent.setup();
    await user.type(box, "costs $5 and $6, and $a+b$");
    await waitFor(() => {
      expect(box.querySelectorAll("[data-type=inline-math]")).toHaveLength(1);
    });
    expect(box.querySelector("[data-type=inline-math]")?.getAttribute("data-latex")).toBe("a+b");
  });

  it("shows a locked answer without a way to change it", () => {
    render(<AnswerEditor initial="Locked." onChange={vi.fn()} label="Your prediction" readOnly />);
    const box = screen.getByRole("textbox", { name: "Your prediction" });
    expect(box.getAttribute("contenteditable")).toBe("false");
    expect(screen.queryByText(/code block/)).toBeNull();
  });
});
