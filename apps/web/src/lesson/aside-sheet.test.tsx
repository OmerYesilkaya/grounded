import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AsideSheet } from "./aside-sheet";

beforeEach(() => {
  // jsdom has no pointer capture.
  Element.prototype.setPointerCapture = vi.fn();
});

function renderSheet() {
  const onClose = vi.fn();
  render(
    <AsideSheet quote="copied out" onClose={onClose}>
      <p>The answer</p>
    </AsideSheet>,
  );
  const sheet = screen.getByRole("dialog", { name: "Question in the margin" });
  const handle = screen.getByText("copied out");
  return { onClose, sheet, handle };
}

const drag = (target: Element, from: number, to: number) => {
  fireEvent.pointerDown(target, { pointerId: 1, button: 0, clientY: from });
  fireEvent.pointerMove(target, { pointerId: 1, clientY: to });
  return () => fireEvent.pointerUp(target, { pointerId: 1, clientY: to });
};

describe("AsideSheet", () => {
  it("follows a drag down by its top, and closes when let go far enough down", () => {
    const { onClose, sheet, handle } = renderSheet();
    const letGo = drag(handle, 500, 650);
    expect(sheet.style.translate).toBe("0 150px");
    letGo();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("springs back from a small drag, and never goes up", () => {
    const { onClose, sheet, handle } = renderSheet();
    drag(handle, 500, 400)();
    expect(sheet.style.translate).toBe("");
    drag(handle, 500, 510)();
    expect(onClose).not.toHaveBeenCalled();
    expect(sheet.style.translate).toBe("");
  });

  it("closes with its button, which is not a handle", () => {
    const { onClose } = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
