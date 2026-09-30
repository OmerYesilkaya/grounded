import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLanguage } from "@/i18n";
import { TaskFields, type TaskFieldsProps } from "./task-fields";

const renderFields = (props: Partial<TaskFieldsProps>) => {
  const all: TaskFieldsProps = {
    form: "predict",
    answer: undefined,
    readOnly: false,
    onChange: vi.fn(),
    onLock: vi.fn(() => Promise.resolve()),
    upload: vi.fn(),
    onError: vi.fn(),
    ...props,
  };
  render(<TaskFields {...all} />);
  return all;
};

describe("TaskFields", () => {
  it("holds back what happened until the prediction is locked", async () => {
    const props = renderFields({ answer: { fields: { prediction: "2000" }, lockedAt: null } });
    expect(screen.getByRole("textbox", { name: "Your prediction" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "What actually happened" })).toBeNull();
    expect(screen.getAllByText("Opens once your prediction is locked.")).toHaveLength(2);
    await userEvent.setup().click(screen.getByRole("button", { name: "Lock my prediction" }));
    expect(props.onLock).toHaveBeenCalled();
  });

  it("shows a locked prediction as locked, and opens the rest", () => {
    renderFields({
      answer: { fields: { prediction: "2000" }, lockedAt: "2026-09-29T10:02:00.000Z" },
    });
    expect(screen.getByRole("textbox", { name: "Your prediction" })).toHaveAttribute(
      "contenteditable",
      "false",
    );
    expect(screen.getByText(/^Locked /)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Lock my prediction" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "What actually happened" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Reconcile" })).toBeInTheDocument();
  });

  it("gives a derivation a step and its because, and adds steps", async () => {
    renderFields({ form: "derivation" });
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
    await userEvent.setup().click(screen.getByRole("button", { name: "Add a step" }));
    expect(screen.getByRole("textbox", { name: "Step 2" })).toBeInTheDocument();
    expect(screen.getAllByRole("textbox", { name: "Because…" })).toHaveLength(2);
  });

  it("shows handed-in answers without a way to change them", () => {
    renderFields({
      form: "explain",
      answer: { fields: { text: "Mine." }, lockedAt: null },
      readOnly: true,
    });
    expect(screen.getByRole("textbox", { name: "Your explanation" })).toHaveAttribute(
      "contenteditable",
      "false",
    );
  });

  describe("in Turkish", () => {
    afterEach(() => {
      act(() => {
        setLanguage("en");
      });
      localStorage.clear();
    });

    it("words the boxes, the lock and the time it was locked", () => {
      act(() => {
        setLanguage("tr");
      });
      renderFields({
        answer: { fields: { prediction: "2000" }, lockedAt: "2026-09-29T10:02:00.000Z" },
      });
      expect(screen.getByRole("textbox", { name: "Tahminin" })).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Gerçekte ne oldu" })).toBeInTheDocument();
      expect(screen.getByText(/^Kilitlendi: 29 Eyl/)).toBeInTheDocument();
    });

    it("words a derivation's steps", async () => {
      act(() => {
        setLanguage("tr");
      });
      renderFields({ form: "derivation" });
      await userEvent.setup().click(screen.getByRole("button", { name: "Adım ekle" }));
      expect(screen.getByRole("textbox", { name: "2. adım" })).toBeInTheDocument();
      expect(screen.getAllByRole("textbox", { name: "Çünkü…" })).toHaveLength(2);
    });
  });
});
