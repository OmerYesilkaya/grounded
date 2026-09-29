import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FinalOutcomeView } from "./final-outcome";

describe("the final's outcome", () => {
  it("sets the fix-list kept along the way beside the one the final found, and the breaks", () => {
    render(
      <FinalOutcomeView
        outcome={{
          before: [
            { text: "Thinks adding one is a single step", open: false },
            { text: "Thinks workers take turns by themselves", open: true },
          ],
          found: [{ text: "Expects a lock to make the work faster", open: true }],
          breaks: [{ term: "working copy", quote: "it just is" }],
          closedAt: "2026-09-29T12:00:00.000Z",
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Track finished" })).toBeInTheDocument();
    const figures = screen.getAllByRole("definition").map((d) => d.textContent);
    expect(figures).toEqual(["2", "1", "1"]);
    expect(screen.getByText("Thinks adding one is a single step")).toHaveTextContent("(fixed)");
    expect(screen.getByText(/Thinks workers take turns/)).toHaveTextContent("still open");
    expect(screen.getByText("Expects a lock to make the work faster")).toBeInTheDocument();
    const broke = screen.getByRole("heading", { name: "Where the chain broke" }).parentElement;
    expect(within(broke ?? document.body).getByText("“it just is”")).toBeInTheDocument();
  });

  it("says so when the final found nothing new and nothing broke", () => {
    render(<FinalOutcomeView outcome={{ before: [], found: [], breaks: [], closedAt: null }} />);
    expect(
      screen.getByText("Nothing new: the fresh audit found no misconception."),
    ).toBeInTheDocument();
    expect(screen.getByText("Nowhere: you gave a reason for every link.")).toBeInTheDocument();
  });
});
