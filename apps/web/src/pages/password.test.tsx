import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { PasswordPage } from "./password";

const auth = vi.hoisted(() => ({ setPassword: vi.fn() }));
vi.mock("@/lib/auth", () => auth);

describe("the password page", () => {
  it("has the first password typed twice, saves it without a current one, and hands over", async () => {
    auth.setPassword.mockResolvedValueOnce({
      id: "u1",
      email: "ada@example.com",
      passwordSet: true,
    });
    const onDone = vi.fn();
    render(<PasswordPage change={false} onDone={onDone} />);

    expect(screen.getByRole("heading", { name: "Choose a password" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("New password"), "a long enough password");
    await userEvent.type(screen.getByLabelText("New password again"), "a long enough passwor");
    await userEvent.click(screen.getByRole("button", { name: "Save password" }));
    expect(await screen.findByText("The two passwords differ.")).toBeInTheDocument();
    expect(auth.setPassword).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText("New password again"), "d");
    await userEvent.click(screen.getByRole("button", { name: "Save password" }));
    expect(auth.setPassword).toHaveBeenCalledWith("a long enough password", undefined);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("changes the password with the current one, and says when that one is wrong", async () => {
    auth.setPassword.mockRejectedValueOnce(new ApiError({ code: "current-password-wrong" }, 403));
    const onDone = vi.fn();
    render(<PasswordPage change onDone={onDone} />);

    expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Current password"), "the old one, maybe");
    await userEvent.type(screen.getByLabelText("New password"), "the new password");
    await userEvent.type(screen.getByLabelText("New password again"), "the new password");
    await userEvent.click(screen.getByRole("button", { name: "Save password" }));
    expect(auth.setPassword).toHaveBeenCalledWith("the new password", "the old one, maybe");
    expect(await screen.findByText("That isn't your current password.")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("words the server's length rule", async () => {
    auth.setPassword.mockRejectedValueOnce(
      new ApiError({ code: "password-length", min: 10, max: 200 }, 400),
    );
    render(<PasswordPage change={false} onDone={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("New password"), "short");
    await userEvent.type(screen.getByLabelText("New password again"), "short");
    await userEvent.click(screen.getByRole("button", { name: "Save password" }));
    expect(
      await screen.findByText("Choose a password of 10 to 200 characters."),
    ).toBeInTheDocument();
  });
});
