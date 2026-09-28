import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SignInPage } from "./sign-in";

vi.mock("@/lib/auth-client", () => ({ authClient: { signIn: { magicLink: vi.fn() } } }));

describe("the sign-in page", () => {
  it("says plainly what is stored, that nothing is shared, and who could read it", () => {
    render(<SignInPage />);
    const note = screen.getByText(/^What is stored:/);
    for (const stored of ["answers", "progress", "questions", "files", "API key, encrypted"])
      expect(note).toHaveTextContent(stored);
    expect(note).toHaveTextContent("Nothing is shared");
    expect(note).toHaveTextContent("can technically access the database, but does not read it");
  });
});
