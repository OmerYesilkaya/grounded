import { initialSession } from "@grounded/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { SessionModel } from "@/lib/session";
import { LessonAgain } from "./lesson-again";

vi.mock("@/lib/api", () => ({ api: vi.fn(() => Promise.resolve(undefined)) }));

const step = (id: string) => ({ id, heading: [], body: [], check: null });

function model(lesson: SessionModel["lesson"], error: string | null = null): SessionModel {
  return {
    id: "session-1",
    trackId: "track-1",
    state: {
      ...initialSession(),
      phase: "lesson",
      plan: "approved",
      lesson: { status: "failed", steps: [] },
    },
    messages: [],
    lesson,
    checks: [],
    activities: [],
    lastEventId: 0,
    error,
  };
}

const renderWith = (m: SessionModel) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <LessonAgain model={m} />
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.mocked(api).mockClear();
});

describe("LessonAgain", () => {
  it("offers the rest again, or the lesson over, after the step that failed", async () => {
    renderWith(
      model({
        steps: [step("s1"), step("s3")],
        totalSteps: 3,
        failedSteps: [{ stepId: "s2", heading: "Two workers" }],
        notes: {},
      }),
    );
    expect(screen.getByText("The rest of the lesson couldn't be written.")).toBeDefined();
    expect(
      screen.getByText("Step 2, “Two workers”, kept breaking the lesson's rules."),
    ).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: "Write the rest again" }));
    expect(api).toHaveBeenCalledWith("/api/sessions/session-1/lesson/write-rest", {
      method: "POST",
    });
    await userEvent.click(screen.getByRole("button", { name: "Start the lesson over" }));
    expect(api).toHaveBeenLastCalledWith("/api/sessions/session-1/lesson/start-over", {
      method: "POST",
    });
  });

  it("starts over a lesson that failed before any step, saying why", async () => {
    renderWith(
      model(
        { steps: [], totalSteps: 0, failedSteps: [], notes: {} },
        "Your OpenAI account is out of credit.",
      ),
    );
    expect(screen.getByText("The lesson couldn't be written.")).toBeDefined();
    expect(screen.getByText("Your OpenAI account is out of credit.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Write the rest again" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Write the lesson again" }));
    expect(api).toHaveBeenCalledWith("/api/sessions/session-1/lesson/start-over", {
      method: "POST",
    });
  });
});
