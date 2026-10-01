import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { SignInPage } from "./sign-in";

const auth = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock("@/lib/auth", () => auth);

describe("the sign-in page", () => {
  it("signs in with the email and the invite code and hands over to the app", async () => {
    auth.signIn.mockResolvedValueOnce({ id: "u1", email: "ada@example.com" });
    const onSignedIn = vi.fn();
    render(<SignInPage onSignedIn={onSignedIn} />);

    await userEvent.type(screen.getByLabelText("Email"), " Ada@example.com ");
    await userEvent.type(screen.getByLabelText("Invite code"), " abcd-efgh-jkmn-pqrs ");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(auth.signIn).toHaveBeenCalledWith("Ada@example.com", "abcd-efgh-jkmn-pqrs");
    expect(onSignedIn).toHaveBeenCalledOnce();
  });

  it("says when the email and code match no invitation, and stays put", async () => {
    auth.signIn.mockRejectedValueOnce(new ApiError({ code: "email-or-code-wrong" }, 403));
    const onSignedIn = vi.fn();
    render(<SignInPage onSignedIn={onSignedIn} />);

    await userEvent.type(screen.getByLabelText("Email"), "eve@example.com");
    await userEvent.type(screen.getByLabelText("Invite code"), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByText("That email and invite code don't match an invitation."),
    ).toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("says plainly what is stored, that nothing is shared, and who could read it", () => {
    render(<SignInPage onSignedIn={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
    const note = screen.getByText(/^What is stored:/);
    for (const stored of ["answers", "progress", "questions", "files", "API key, encrypted"])
      expect(note).toHaveTextContent(stored);
    expect(note).toHaveTextContent("Nothing is shared");
    expect(note).toHaveTextContent("can technically access the database, but does not read it");
  });
});
