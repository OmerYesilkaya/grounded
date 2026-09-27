import type { SessionState } from "@grounded/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { ChatMessage, SessionModel } from "@/lib/session";
import { ChatView } from "./chat-view";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/lib/api", () => ({ api: vi.fn(() => Promise.resolve(undefined)) }));

const state: SessionState = {
  phase: "probe",
  plan: "none",
  lesson: { status: "none", steps: [] },
  steps: {},
  currentStep: null,
};

function model(messages: ChatMessage[]): SessionModel {
  return {
    id: "s1",
    trackId: "t1",
    state,
    messages,
    lesson: null,
    checks: [],
    activities: [],
    lastEventId: 0,
    error: null,
  };
}

const message = (
  id: string,
  role: ChatMessage["role"],
  text: string,
  streaming = false,
): ChatMessage => ({ id, role, kind: "message", text, blocks: null, streaming });

function renderChat(messages: ChatMessage[]) {
  const client = new QueryClient();
  const view = (m: SessionModel) => (
    <QueryClientProvider client={client}>
      <ChatView model={m} onOpenLesson={vi.fn()} />
    </QueryClientProvider>
  );
  const { rerender } = render(view(model(messages)));
  return (next: ChatMessage[]) => {
    rerender(view(model(next)));
  };
}

beforeEach(() => {
  vi.mocked(api).mockClear();
  Element.prototype.scrollIntoView = vi.fn();
});

describe("ChatView: the composer", () => {
  it("is focused when the probe opens, and sends on Enter", async () => {
    const user = userEvent.setup();
    renderChat([message("m1", "tutor", "What do you already know about counters?")]);
    const box = screen.getByRole("textbox", { name: "Message" });
    expect(box).toHaveFocus();

    await user.keyboard("a number that goes up{Enter}");
    expect(api).toHaveBeenCalledWith("/api/sessions/s1/messages", {
      method: "POST",
      body: JSON.stringify({ text: "a number that goes up" }),
    });
    expect(box).toHaveFocus();
  });

  it("is focused again when the tutor's reply finishes", () => {
    const first = message("m1", "tutor", "What do you already know about counters?");
    const answer = message("m2", "learner", "a number that goes up");
    const update = renderChat([first, answer]);
    const box = screen.getByRole("textbox", { name: "Message" });
    expect(box).toBeDisabled();
    box.blur();

    update([first, answer, message("m3", "tutor", "And when two people add at", true)]);
    expect(box).toBeDisabled();

    update([first, answer, message("m3", "tutor", "And when two people add at once?")]);
    expect(box).toBeEnabled();
    expect(box).toHaveFocus();
  });
});

describe("ChatView: what the tutor is doing", () => {
  it("shows the current activity, with its reasoning behind a toggle", async () => {
    const user = userEvent.setup();
    const current = model([]);
    current.activities = [
      { id: "a1", label: "Researching the subject", detail: null, reasoning: "" },
      {
        id: "a2",
        label: "Searching the web for",
        detail: "“area of a triangle”",
        reasoning: "Start from rectangles.",
      },
    ];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatView model={current} onOpenLesson={vi.fn()} />
      </QueryClientProvider>,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Searching the web for“area of a triangle”");
    expect(screen.queryByText("Start from rectangles.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show thinking" }));
    expect(screen.getByText("Start from rectangles.")).toBeInTheDocument();
  });
});
