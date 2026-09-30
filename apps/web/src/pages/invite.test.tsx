import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InvitePage } from "./invite";

describe("the invite page", () => {
  it("spends the link only on the button, sending the browser to the verify endpoint", async () => {
    const navigate = vi.fn();
    render(<InvitePage token="abc" email="ada@example.com" navigate={navigate} />);
    expect(screen.getByText(/signs you in as ada@example.com/)).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(navigate).toHaveBeenCalledWith(
      "/api/auth/magic-link/verify?token=abc&callbackURL=%2F&errorCallbackURL=%2Finvite",
    );
  });

  it("carries the sign-up sentence on what is stored, since an invited person never sees the sign-in page", () => {
    render(<InvitePage token="abc" navigate={vi.fn()} />);
    expect(screen.getByText(/^What is stored:/)).toHaveTextContent("Nothing is shared");
  });

  it("explains a spent or missing token and offers the email route instead", () => {
    render(<InvitePage error="INVALID_TOKEN" navigate={vi.fn()} />);
    expect(screen.getByRole("heading")).toHaveTextContent("used or has expired");
    expect(screen.getByRole("link", { name: /by email/ })).toHaveAttribute("href", "/sign-in");
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
  });
});
