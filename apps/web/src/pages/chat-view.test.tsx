import { parseBlocks } from "@grounded/content";
import type { SessionState } from "@grounded/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { ChatMessage, SessionModel } from "@/lib/session";
import { fakePage } from "@/test-page";
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
    asides: [],
    assignments: [],
    hasAskedAside: false,
    activities: [],
    lastEventId: 0,
    error: null,
    stalled: false,
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

let page: ReturnType<typeof fakePage>;

beforeEach(() => {
  vi.mocked(api).mockClear();
  // A 2000px conversation in an 800px viewport, scrolled to the bottom.
  page = fakePage({ height: 2000, viewport: 800, y: 1200 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChatView: following the conversation", () => {
  function renderFollowing(streaming: boolean) {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatView
          model={model([message("m1", "tutor", "What do you already know?", streaming)])}
          onOpenLesson={vi.fn()}
        />
      </QueryClientProvider>,
    );
    const chat = container.firstElementChild;
    if (!chat) throw new Error("the chat didn't render");
    return chat;
  }
  const jumpButton = () => screen.queryByRole("button", { name: "Jump to latest" });

  it("keeps the latest line in view as the reply grows, and leaves a learner who scrolled up", async () => {
    const user = userEvent.setup();
    const chat = renderFollowing(true);
    page.resize(chat, 2300);
    expect(page.page.y).toBe(1500);
    expect(jumpButton()).toBeNull();

    page.scroll(700);
    page.resize(chat, 2600);
    expect(page.page.y).toBe(700);

    const jump = jumpButton();
    if (!jump) throw new Error("no jump button");
    await user.click(jump);
    expect(page.scrollTo).toHaveBeenLastCalledWith({ top: 2600, behavior: "smooth" });
    expect(jumpButton()).toBeNull();
    page.resize(chat, 2900);
    expect(page.page.y).toBe(2100);
  });

  it("goes to the bottom when the learner sends", async () => {
    const user = userEvent.setup();
    const chat = renderFollowing(false);
    page.scroll(300);
    expect(jumpButton()).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Message" }), "not much{Enter}");
    expect(page.page.y).toBe(1200);
    expect(jumpButton()).toBeNull();
    page.resize(chat, 2400);
    expect(page.page.y).toBe(1600);
  });
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

describe("ChatView: a job that stopped", () => {
  const renderModel = (m: SessionModel) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatView model={m} onOpenLesson={vi.fn()} />
      </QueryClientProvider>,
    );

  it("offers to try the homework again, saying why it stopped", async () => {
    const user = userEvent.setup();
    const stopped = model([message("m1", "tutor", "Here is the lesson's last check.")]);
    stopped.state = { ...state, phase: "homework", plan: "approved" };
    stopped.error = "Your OpenAI account is out of credit.";
    renderModel(stopped);

    expect(screen.getByText("Your OpenAI account is out of credit.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(api).toHaveBeenCalledWith("/api/sessions/s1/retry", { method: "POST" });
  });

  it("offers it after a reload too, when the session waits on a job nothing is doing", () => {
    const stopped = model([message("m1", "learner", "it just adds one")]);
    stopped.stalled = true;
    renderModel(stopped);
    expect(screen.getByText("The tutor stopped before finishing.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    // Not "Thinking…": nothing is.
    expect(screen.queryByText("Thinking…")).toBeNull();
  });

  it("doesn't offer it on the learner's turn, or while the tutor is at work", () => {
    const answered = model([message("m1", "tutor", "What happens when you add one?")]);
    answered.error = "Something went wrong on our side. Try again in a moment.";
    renderModel(answered);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});

describe("ChatView: a streamed reply", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("appears as if written, and turns into blocks once all of it is shown", () => {
    vi.useFakeTimers();
    const markdown = `Picture **two workers** adding to one counter. ${"Each reads it first. ".repeat(8)}`;
    const update = renderChat([message("m1", "tutor", "", true)]);
    update([message("m1", "tutor", markdown, true)]);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const shown = screen.getByText(/^Picture/).textContent;
    expect(shown.length).toBeGreaterThan(20);
    expect(shown.length).toBeLessThan(markdown.length);

    const { blocks } = parseBlocks(markdown);
    update([{ ...message("m1", "tutor", markdown), blocks }]);
    expect(screen.queryByText("two workers")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByText("two workers").tagName).toBe("STRONG");
    expect(screen.getByText(/^Picture/)).toHaveTextContent(markdown.replaceAll("**", "").trim());
  });
});
