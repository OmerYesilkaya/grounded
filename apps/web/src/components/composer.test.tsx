import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Composer, type ComposerProps } from "./composer";

function Harness(props: Partial<Omit<ComposerProps, "value" | "onChange">>) {
  const [value, setValue] = useState("");
  return (
    <Composer
      label="Message"
      submitLabel="Send"
      onSubmit={vi.fn()}
      {...props}
      value={value}
      onChange={setValue}
    />
  );
}

describe("Composer", () => {
  it("sends the trimmed text on Enter and adds a line on Shift+Enter", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const box = screen.getByRole("textbox", { name: "Message" });

    await user.type(box, "first line{Shift>}{Enter}{/Shift}second line");
    expect(box).toHaveValue("first line\nsecond line");
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(box, "  {Enter}");
    expect(onSubmit).toHaveBeenCalledWith("first line\nsecond line");
    expect(box).toHaveValue("first line\nsecond line  ");
  });

  it("sends with the button, and not while there is nothing to send", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const button = screen.getByRole("button", { name: "Send" });

    expect(button).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Message" }), "   {Enter}");
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(screen.getByRole("textbox", { name: "Message" }), "hello");
    await user.click(button);
    expect(onSubmit).toHaveBeenCalledWith("hello");
  });

  it("does not send on the Enter that confirms an IME composition", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(box, { target: { value: "にほん" } });

    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("にほん");
  });

  it("neither edits nor sends when disabled, nor sends when sending is held back", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const { rerender } = render(
      <Composer
        label="Message"
        submitLabel="Send"
        value="hi"
        onChange={vi.fn()}
        onSubmit={onSubmit}
        disabled
      />,
    );
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    rerender(
      <Composer
        label="Message"
        submitLabel="Send"
        value="hi"
        onChange={vi.fn()}
        onSubmit={onSubmit}
        submitDisabled
      />,
    );
    const box = screen.getByRole("textbox", { name: "Message" });
    expect(box).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await user.type(box, "{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows the placeholder and extra actions", async () => {
    const user = userEvent.setup();
    const onExtra = vi.fn();
    render(
      <Harness
        placeholder="Say something"
        actions={
          <button type="button" onClick={onExtra}>
            Extra
          </button>
        }
      />,
    );
    expect(screen.getByPlaceholderText("Say something")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Extra" }));
    expect(onExtra).toHaveBeenCalled();
  });
});
