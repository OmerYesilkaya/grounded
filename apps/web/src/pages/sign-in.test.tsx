import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { SignInPage } from "./sign-in";

const auth = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock("@/lib/auth", () => auth);

describe("the sign-in page", () => {
  it("signs in with the email and the password (the invite code, the first time) and hands over", async () => {
    auth.signIn.mockResolvedValueOnce({ id: "u1", email: "ada@example.com", passwordSet: false });
    const onSignedIn = vi.fn();
    render(<SignInPage onSignedIn={onSignedIn} />);

    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Email"), " Ada@example.com ");
    await userEvent.type(screen.getByLabelText("Password"), "abcd-efgh-jkmn-pqrs");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(auth.signIn).toHaveBeenCalledWith("Ada@example.com", "abcd-efgh-jkmn-pqrs");
    expect(onSignedIn).toHaveBeenCalledOnce();
  });

  it("says when the email and password match nothing, or sign-in is locked, and stays put", async () => {
    auth.signIn
      .mockRejectedValueOnce(new ApiError({ code: "email-or-password-wrong" }, 403))
      .mockRejectedValueOnce(new ApiError({ code: "too-many-attempts" }, 429));
    const onSignedIn = vi.fn();
    render(<SignInPage onSignedIn={onSignedIn} />);

    await userEvent.type(screen.getByLabelText("Email"), "eve@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "nope nope");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/That email and password don't match/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/Too many wrong tries/)).toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("says plainly what is stored, that nothing is shared, and that sessions are recorded", () => {
    render(<SignInPage onSignedIn={vi.fn()} />);
    const note = screen.getByText(/^What is stored:/);
    for (const stored of ["answers", "progress", "questions", "files", "API key, encrypted"])
      expect(note).toHaveTextContent(stored);
    expect(note).toHaveTextContent("Nothing is shared");
    expect(note).toHaveTextContent("everything in your sessions is recorded");
  });
});
