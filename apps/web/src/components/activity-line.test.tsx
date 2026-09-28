import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActivityLine } from "./activity-line";

describe("ActivityLine", () => {
  it("shimmers the running activity's label, not its detail", () => {
    render(
      <ActivityLine
        activities={[
          { id: "a1", label: "Searching the web for", detail: "“triangles”", reasoning: "" },
        ]}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Searching the web for“triangles”");
    expect(screen.getByText("Searching the web for")).toHaveClass("text-shimmer");
    expect(screen.getByText("“triangles”")).not.toHaveClass("text-shimmer");
  });

  it("shimmers the fallback while the learner waits", () => {
    render(<ActivityLine activities={[]} fallback="Thinking…" />);
    expect(screen.getByText("Thinking…")).toHaveClass("text-shimmer");
  });

  it("shows nothing once nothing is in progress", () => {
    render(<ActivityLine activities={[]} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
