import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { TeachingNote } from "@/lib/teaching-notes";
import { TeachingNotesPage } from "./teaching-notes";

vi.mock("@tanstack/react-router", () => ({
  Link: (props: { to: string; params?: Record<string, string>; children: ReactNode }) => (
    <a href={props.to.replace("$sessionId", props.params?.sessionId ?? "")}>{props.children}</a>
  ),
}));
vi.mock("@/lib/api", () => ({ api: vi.fn(), ApiError: class ApiError extends Error {} }));

const note: TeachingNote = {
  id: "n1",
  text: "One concrete example before the rule.",
  byLearner: false,
  revisedAt: "2026-09-20T10:00:00.000Z",
  evidence: [1, 3, 5].map((number) => ({
    what: "the check landed after the example",
    session: { id: `s${String(number)}`, trackTitle: "Concurrency", number },
  })),
};

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TeachingNotesPage />
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.mocked(api).mockReset();
});

describe("the teaching notes page (design §8)", () => {
  it("shows each note with the sessions it rests on", async () => {
    vi.mocked(api).mockResolvedValue([note]);
    show();
    expect(await screen.findByText(note.text)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Seen in 3 sessions" }));
    expect(screen.getByRole("link", { name: "Concurrency, session 3" }).getAttribute("href")).toBe(
      "/sessions/s3",
    );
  });

  it("saves a note the learner changes", async () => {
    vi.mocked(api).mockResolvedValueOnce([note]);
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Edit this note" }));
    const box = screen.getByRole("textbox", { name: "The note" });
    await userEvent.clear(box);
    await userEvent.type(box, "Pictures first.");
    vi.mocked(api).mockResolvedValueOnce([{ ...note, text: "Pictures first.", byLearner: true }]);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(vi.mocked(api)).toHaveBeenLastCalledWith("/api/profile/notes/n1", {
      method: "PATCH",
      body: JSON.stringify({ text: "Pictures first." }),
    });
    expect(await screen.findByText("Pictures first.")).toBeTruthy();
    expect(screen.getByText("You edited this")).toBeTruthy();
  });

  it("says what comes before there are any", async () => {
    vi.mocked(api).mockResolvedValue([]);
    show();
    expect(await screen.findByText(/After about six sessions/)).toBeTruthy();
  });
});
