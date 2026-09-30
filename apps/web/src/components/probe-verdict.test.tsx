import type { ProbeVerdict } from "@grounded/core/probe-verdict";
import type { SessionState } from "@grounded/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { ChatMessage, SessionModel, VerdictState } from "@/lib/session";
import { ChatView } from "@/pages/chat-view";
import { VerdictSeam, WhereYouStarted } from "./probe-verdict";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a href="/somewhere">{children}</a>,
}));
vi.mock("@/lib/api", () => ({ api: vi.fn(() => Promise.resolve(undefined)) }));

const VERDICT: ProbeVerdict = {
  strands: [
    {
      name: "What adding one does",
      band: "working",
      text: "You know a program changes a number in memory; it got shaky with two at once.",
    },
    { name: "Memory", band: "solid", text: "You used it with confidence." },
  ],
  overall: { band: "working", text: "You have something to build on." },
};

const state: SessionState = {
  phase: "plan",
  plan: "proposed",
  lesson: { status: "none", steps: [] },
  steps: {},
  currentStep: null,
};

const tutor = (id: string, kind: ChatMessage["kind"], text: string): ChatMessage => ({
  id,
  role: "tutor",
  kind,
  text,
  blocks: null,
});

function model(verdict: VerdictState | null, messages: ChatMessage[] = []): SessionModel {
  return {
    id: "s1",
    trackId: "t1",
    state,
    messages,
    lesson: null,
    checks: [],
    asides: [],
    assignments: [],
    takenUp: [],
    hasAskedAside: false,
    activities: [],
    lastEventId: 0,
    error: null,
    stalled: false,
    verdict,
  };
}

const offered: VerdictState = { status: "offered", verdict: null, failure: null };

const inClient = (node: ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
);

beforeEach(() => {
  vi.mocked(api).mockClear();
});

describe("see where you stand, at the seam", () => {
  it("is offered, not shown, and asks for it on a tap", async () => {
    render(inClient(<VerdictSeam model={model(offered)} />));
    expect(screen.queryByText("You have something to build on.")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "See where you stand" }));
    expect(api).toHaveBeenCalledWith("/api/sessions/s1/verdict", { method: "POST" });
  });

  it("shows it being worked out from the tap on, before the stream says so", async () => {
    const tapped = model(offered);
    const { rerender } = render(inClient(<VerdictSeam model={tapped} />));
    await userEvent.click(screen.getByRole("button", { name: "See where you stand" }));
    // The request is answered, and no event has arrived yet: still being worked out.
    await screen.findByText("Working out where you stand…");
    rerender(inClient(<VerdictSeam model={tapped} />));
    expect(screen.queryByRole("button", { name: "See where you stand" })).toBeNull();
    // It failed after all: the learner can ask again, and that tap shows at once too.
    const failed = model({ status: "failed", verdict: null, failure: "Out of credit." });
    rerender(inClient(<VerdictSeam model={failed} />));
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Working out where you stand…");
    rerender(
      inClient(
        <VerdictSeam model={model({ status: "failed", verdict: null, failure: "Again." })} />,
      ),
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("says it is being worked out, then shows the verdict in bands, never a number", () => {
    const { rerender, container } = render(
      inClient(<VerdictSeam model={model({ ...offered, status: "writing" })} />),
    );
    expect(screen.getByText("Working out where you stand…")).toBeTruthy();
    rerender(
      inClient(
        <VerdictSeam model={model({ status: "written", verdict: VERDICT, failure: null })} />,
      ),
    );
    expect(screen.getByRole("region", { name: "Where you stand" })).toBeTruthy();
    expect(screen.getByText("You have something to build on.")).toBeTruthy();
    expect(screen.getByText("What adding one does")).toBeTruthy();
    expect(screen.getAllByText("Working")).toHaveLength(2);
    expect(screen.getByText("Solid")).toBeTruthy();
    expect(container.textContent).not.toMatch(/\d/);
  });

  it("says why it failed, and lets the learner ask again", async () => {
    render(
      inClient(
        <VerdictSeam
          model={model({ status: "failed", verdict: null, failure: "Out of credit." })}
        />,
      ),
    );
    expect(screen.getByText("Out of credit.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(api).toHaveBeenCalledWith("/api/sessions/s1/verdict", { method: "POST" });
  });

  it("shows nothing when the session offers none", () => {
    const { container } = render(inClient(<VerdictSeam model={model(null)} />));
    expect(container.textContent).toBe("");
  });

  it("sits between the probe and the plan in the chat", () => {
    render(
      inClient(
        <ChatView
          model={model(offered, [
            tutor("m1", "message", "What happens when a program adds one?"),
            { id: "m2", role: "learner", kind: "message", text: "It adds one.", blocks: null },
            tutor("m3", "plan", "We start from memory."),
          ])}
          onOpenLesson={vi.fn()}
        />,
      ),
    );
    const seam = screen.getByRole("button", { name: "See where you stand" });
    const answer = screen.getByText("It adds one.");
    const plan = screen.getByText("The plan");
    expect(answer.compareDocumentPosition(seam) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(seam.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("where you started, on the track page", () => {
  it("is an entry with the overall band that opens the verdict", async () => {
    render(<WhereYouStarted verdict={VERDICT} />);
    const entry = screen.getByRole("button", { name: /Where you started/ });
    expect(entry.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("You have something to build on.")).toBeNull();
    await userEvent.click(entry);
    expect(entry.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("You have something to build on.")).toBeTruthy();
  });
});
