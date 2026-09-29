import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Assignment } from "@/lib/assignments";
import { HomeworkPage } from "./homework";

vi.mock("@tanstack/react-router", () => ({
  Link: (props: { children: ReactNode }) => <a href="/">{props.children}</a>,
}));
vi.mock("@/components/page-bar", () => ({
  PageBar: (props: { start: ReactNode; end: ReactNode }) => (
    <header>
      {props.start}
      {props.end}
    </header>
  ),
}));
vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const paragraph = (id: string, value: string) => ({
  id,
  type: "paragraph" as const,
  children: [{ type: "text" as const, value }],
});

const EXAM: Assignment = {
  id: "a1",
  trackId: "t1",
  trackTitle: "How software works",
  sessionId: "s1",
  session: { number: 4, waiting: false },
  kind: "exam",
  title: "Counters everywhere",
  tasks: [
    {
      id: "t1",
      title: "A shared bank balance",
      form: "predict",
      blocks: [paragraph("t1.b1", "Two cash machines pay out from one balance.")],
    },
    {
      id: "t2",
      title: "Why waiting fixes it",
      form: "explain",
      blocks: [paragraph("t2.b1", "Explain why the wait makes it correct.")],
    },
  ],
  checklist: [{ id: "c1", text: "Sees the vanished payment in a new setting" }],
  answers: {},
  createdAt: "2026-09-29T10:00:00.000Z",
  submittedAt: null,
  snoozedUntil: null,
  subsumedBy: null,
  review: null,
  lastEventId: 0,
};

const renderPage = (assignment: Assignment) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <HomeworkPage assignment={assignment} />
    </QueryClientProvider>,
  );

describe("an arc exam's page", () => {
  it("shows every part, each with its kind, what it asks and its own answer boxes", () => {
    renderPage(EXAM);
    expect(screen.getByText("Arc exam · 2 parts")).toBeInTheDocument();
    const exam = screen.getByRole("article", { name: "The exam" });
    expect(
      within(exam)
        .getAllByRole("region")
        .map((part) => part.textContent),
    ).toEqual([
      expect.stringContaining("A shared bank balance"),
      expect.stringContaining("Why waiting fixes it"),
    ]);
    expect(screen.getByText("Part 1 · Predict, then verify")).toBeInTheDocument();
    expect(screen.getByText("Part 2 · Explain it to a friend")).toBeInTheDocument();
    expect(screen.getByText("Explain why the wait makes it correct.")).toBeInTheDocument();
    expect(screen.getByText("Your prediction")).toBeInTheDocument();
    expect(screen.getByText("Your explanation")).toBeInTheDocument();
    expect(screen.getByText(/Take it in one sitting/)).toBeInTheDocument();
  });

  it("is handed in only whole: an unanswered part says what is missing", async () => {
    renderPage(EXAM);
    await userEvent.click(screen.getByRole("button", { name: "Hand it in" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Lock your prediction in “A shared bank balance” before you check it.",
    );
  });
});
