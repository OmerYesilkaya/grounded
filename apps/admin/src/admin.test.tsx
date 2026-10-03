import type { CallDetail, Overview, Replay } from "@grounded/core/admin";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminRouter, createQueryClient } from "./router";

/** The API as a table of paths: a number is a status with no body. */
function stubApi(answers: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) => {
      const path = input.replace(/\?.*$/, "");
      const answer = answers[path] ?? 404;
      return Promise.resolve(
        typeof answer === "number" ? new Response(null, { status: answer }) : Response.json(answer),
      );
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function open(path: string) {
  const router = createAdminRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const ME = { "/api/admin/me": { email: "omer@example.com" } };

const CALL = {
  id: "c1",
  purpose: "check",
  model: "gpt-6-luna",
  status: "ok" as const,
  errorKind: null,
  durationMs: 2400,
  inputTokens: 12000,
  cachedInputTokens: 9000,
  outputTokens: 300,
  costUsd: 0.004,
  methodVersion: "0123456789ab",
  stored: true,
  verdict: { rewrite: 0, issues: [{ code: "check/repair-asks", message: "The repair asks." }] },
};

const REPLAY: Replay = {
  session: {
    id: "s1",
    learner: 3,
    kind: "normal",
    phase: "lesson",
    startedAt: "2026-10-01T09:00:00.000Z",
    closedAt: null,
    probeSummary: "Knowledge ends at: adding one is one step.",
    reviewSummary: null,
    earlierSummary: null,
  },
  track: { id: "t1", title: "Concurrency", goal: "Why counters lose updates", language: null },
  lesson: {
    steps: [{ id: "s1", status: "passed", misses: 1 }],
    failedSteps: [],
    notes: {},
    alreadyHeld: {},
  },
  timeline: [
    {
      at: "2026-10-01T09:10:00.000Z",
      kind: "step",
      stepId: "s1",
      heading: "Adding one is three moves",
      text: "The value is copied out.",
      source: null,
    },
    {
      at: "2026-10-01T09:11:00.000Z",
      kind: "check",
      stepId: "s1",
      role: "learner",
      text: "the new value",
      verdict: null,
      failure: null,
    },
    { at: "2026-10-01T09:11:05.000Z", kind: "call", call: CALL },
    {
      at: "2026-10-01T09:11:06.000Z",
      kind: "check",
      stepId: "s1",
      role: "tutor",
      text: "Close. Memory keeps the old value.",
      verdict: "missed",
      failure: null,
    },
  ],
};

const DETAIL: CallDetail = {
  id: "c1",
  sessionId: "s1",
  trackId: "t1",
  learner: 3,
  at: "2026-10-01T09:11:05.000Z",
  purpose: "check",
  provider: "openai",
  model: "gpt-6-luna",
  status: "ok",
  errorKind: null,
  durationMs: 2400,
  tokens: { input: 12000, cachedInput: 9000, cacheWrite: 0, output: 300 },
  costUsd: 0.004,
  methodVersion: "0123456789ab",
  release: null,
  content: {
    prompt: [
      { role: "system", content: "You teach from first principles." },
      { role: "user", content: [{ type: "text", text: "The learner answered: the new value" }] },
    ],
    responseFormat: null,
    tools: null,
    settings: {},
    reply: { content: [{ type: "text", text: '{"verdict":"missed"}' }], finishReason: "stop" },
    error: null,
    verdict: CALL.verdict,
  },
};

describe("the admin panel", () => {
  it("sends someone signed out to the app's sign-in", async () => {
    stubApi({ "/api/admin/me": 401 });
    open("/admin/");
    expect(await screen.findByText("Sign in to Grounded first")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "http://localhost:5173/sign-in",
    );
  });

  it("opens nothing for someone who isn't an operator", async () => {
    stubApi({ "/api/admin/me": 404 });
    open("/admin/sessions");
    expect(await screen.findByText("This account isn't an operator")).toBeInTheDocument();
  });

  it("replays a session, and opens a call in full beside it", async () => {
    stubApi({ ...ME, "/api/admin/sessions/s1": REPLAY, "/api/admin/calls/c1": DETAIL });
    open("/admin/sessions/s1");

    expect(await screen.findByText("Learner 3 · Concurrency")).toBeInTheDocument();
    expect(screen.getByText("the new value")).toBeInTheDocument();
    expect(screen.getByText("missed")).toBeInTheDocument();
    const call = screen.getByRole("button", { name: /check.*gpt-6-luna/ });
    expect(call).toHaveTextContent("1 issue");

    await userEvent.click(call);
    expect(await screen.findByText("Model call")).toBeInTheDocument();
    expect(screen.getByText("check/repair-asks")).toBeInTheDocument();
    expect(screen.getByText("The learner answered: the new value")).toBeInTheDocument();
    expect(screen.getByText('{"verdict":"missed"}')).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("Show the model calls between the turns"));
    expect(screen.queryByRole("button", { name: /check.*gpt-6-luna/ })).not.toBeInTheDocument();
  });

  it("links each figure of the overview to the sessions behind it", async () => {
    const overview: Overview = {
      totals: { learners: 2, sessions: 5, closed: 3, calls: 120, costUsd: 1.5 },
      checks: { checked: 8, firstTry: 6, misses: 3, settling: 1, byModel: [] },
      validators: {
        byPurpose: [],
        issues: [
          {
            code: "lesson/missing-check",
            purpose: "lesson",
            model: "gpt-6-luna",
            count: 4,
            sessions: 2,
            example: "Step s2 has no check.",
          },
        ],
      },
      failures: {
        calls: [],
        shown: 0,
        latestShown: [],
        failedSteps: 0,
        unanswered: { checks: 0, asides: 0, reviewThreads: 0 },
      },
      asides: { total: 0, latest: [] },
      alreadyHeld: { total: 0, latest: [] },
      sessions: { furthest: [{ phase: "lesson", sessions: 5 }], idle: [], plans: [] },
      homework: { assignments: [], reviews: [] },
      calls: { byPurpose: [], byModel: [] },
    };
    stubApi({
      ...ME,
      "/api/admin/overview": overview,
      "/api/admin/filters": { models: [], methods: [] },
    });
    open("/admin/?period=90");

    expect(await screen.findByText("75%")).toBeInTheDocument();
    expect(screen.getByText("lesson/missing-check")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "2" })).toHaveAttribute(
      "href",
      "/admin/sessions?period=90&issue=lesson%2Fmissing-check",
    );
  });
});
