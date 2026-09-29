import { initialSession } from "@grounded/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readableSteps, useSessionModel, type SessionSnapshot } from "./session";

/** A stand-in for the browser's EventSource: the test plays the server. */
class FakeEventSource {
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();
  readyState = 1;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(type: string, id: number, data: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(data), lastEventId: String(id) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** What the browser does when a reconnect gets an error response: close, for good. */
  giveUp() {
    this.readyState = FakeEventSource.CLOSED;
    for (const listener of this.listeners.get("error") ?? []) listener(new MessageEvent("error"));
  }

  static open(): FakeEventSource[] {
    return FakeEventSource.instances.filter((s) => s.readyState !== FakeEventSource.CLOSED);
  }
}

const SESSION_ID = "0190c2a0-0000-7000-8000-000000000001";
const tutor = { role: "tutor", kind: "message" } as const;

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: SESSION_ID,
    trackId: "0190c2a0-0000-7000-8000-000000000002",
    state: initialSession(),
    messages: [],
    lesson: null,
    checks: [],
    asides: [],
    assignments: [],
    hasAskedAside: false,
    lastEventId: 7,
    activities: [],
    stalled: false,
    ...overrides,
  };
}

function serve(body: SessionSnapshot) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json(body))),
  );
}

async function renderModel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StrictMode>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </StrictMode>
  );
  const rendered = renderHook(() => useSessionModel(SESSION_ID), { wrapper });
  await waitFor(() => {
    expect(rendered.result.current).toBeDefined();
  });
  return rendered;
}

/** The one stream the page is listening on. */
function openStream(): FakeEventSource {
  const open = FakeEventSource.open();
  expect(open).toHaveLength(1);
  const [source] = open;
  if (!source) throw new Error("no stream");
  return source;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  serve(snapshot());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useSessionModel", () => {
  it("streams from where the snapshot ends", async () => {
    await renderModel();
    expect(openStream().url).toBe(`/api/sessions/${SESSION_ID}/stream?after=7`);
  });

  it("shows a tutor message that starts after the page opened", async () => {
    const { result } = await renderModel();
    const source = openStream();
    act(() => {
      source.emit("message-start", 8, { id: "m1", ...tutor });
      source.emit("message-delta", 9, { id: "m1", text: "What does " });
      source.emit("message-delta", 10, { id: "m1", text: "area measure?" });
    });
    expect(result.current?.messages).toEqual([
      expect.objectContaining({ id: "m1", text: "What does area measure?", streaming: true }),
    ]);
    act(() => {
      source.emit("message-done", 11, { id: "m1", ...tutor, blocks: [] });
    });
    expect(result.current?.messages).toEqual([
      expect.objectContaining({ id: "m1", blocks: [], streaming: false }),
    ]);
  });

  it("finishes a tutor message the snapshot caught part-way", async () => {
    // The tutor had started the opening question before the page loaded.
    serve(
      snapshot({
        messages: [{ id: "m1", ...tutor, text: "What does ", blocks: null, streaming: true }],
      }),
    );
    const { result } = await renderModel();
    const source = openStream();
    act(() => {
      source.emit("message-delta", 8, { id: "m1", text: "area measure?" });
      source.emit("message-done", 9, { id: "m1", ...tutor, blocks: [] });
    });
    expect(result.current?.messages).toEqual([
      expect.objectContaining({ id: "m1", text: "What does area measure?", streaming: false }),
    ]);
  });

  it("applies each event once, in order, when the stream replays", async () => {
    const { result } = await renderModel();
    const source = openStream();
    act(() => {
      source.emit("message", 8, { id: "a", role: "learner", kind: "message", text: "one" });
      source.emit("message", 9, { id: "b", role: "learner", kind: "message", text: "two" });
      source.emit("message", 8, { id: "a", role: "learner", kind: "message", text: "one" });
    });
    expect(result.current?.messages.map((m) => m.text)).toEqual(["one", "two"]);
  });

  it("opens a new stream from the last event when the browser gives up on one", async () => {
    const { result } = await renderModel();
    const first = openStream();
    act(() => {
      first.emit("lesson-outline", 8, { totalSteps: 12 });
    });
    vi.useFakeTimers();
    act(() => {
      first.giveUp();
    });
    expect(FakeEventSource.open()).toHaveLength(0);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    const second = openStream();
    expect(second.url).toBe(`/api/sessions/${SESSION_ID}/stream?after=8`);

    const step = { id: "s1", heading: "Area", body: [] };
    act(() => {
      second.emit("lesson-step", 9, { step });
    });
    expect(result.current?.lesson).toMatchObject({ totalSteps: 12, steps: [step] });
  });
});

describe("useSessionModel: what the tutor is doing", () => {
  const thinking = { id: "a1", label: "Thinking…", detail: null };

  it("shows an activity while it runs, follows its changes, and drops it when done", async () => {
    const { result } = await renderModel();
    const source = openStream();
    act(() => {
      source.emit("activity", 8, { ...thinking, state: "running" });
    });
    expect(result.current?.activities).toEqual([{ ...thinking, reasoning: "" }]);
    act(() => {
      source.emit("activity", 9, {
        id: "a1",
        label: "Writing step 2 of 12",
        detail: null,
        state: "running",
      });
    });
    expect(result.current?.activities.map((a) => a.label)).toEqual(["Writing step 2 of 12"]);
    act(() => {
      source.emit("activity", 10, {
        id: "a1",
        label: "Writing step 2 of 12",
        detail: null,
        state: "done",
      });
    });
    expect(result.current?.activities).toEqual([]);
  });

  it("keeps the model's reasoning with its activity", async () => {
    const { result } = await renderModel();
    const source = openStream();
    act(() => {
      source.emit("activity", 8, { ...thinking, state: "running" });
      source.emit("activity-reasoning", 9, { id: "a1", text: "The learner said " });
      source.emit("activity-reasoning", 10, { id: "a1", text: "width times height." });
    });
    expect(result.current?.activities[0]?.reasoning).toBe("The learner said width times height.");
  });

  it("picks up activities already running when the page opened", async () => {
    serve(snapshot({ activities: [{ ...thinking, state: "running" }] }));
    const { result } = await renderModel();
    expect(result.current?.activities).toEqual([{ ...thinking, reasoning: "" }]);
  });

  it("tells a session error apart from the stream's own connection errors", async () => {
    const { result } = await renderModel();
    const source = openStream();
    act(() => {
      // The browser's connection error: an event named "error" with no data.
      for (const listener of source.listeners.get("error") ?? [])
        listener(new MessageEvent("error"));
    });
    expect(result.current?.error).toBeNull();
    act(() => {
      source.emit("error", 8, { message: "Your OpenAI key was rejected." });
    });
    expect(result.current?.error).toBe("Your OpenAI key was rejected.");
  });
});

describe("a job that stopped", () => {
  it("is behind the session once a job is at work again", async () => {
    serve(snapshot({ stalled: true }));
    const { result } = await renderModel();
    const source = openStream();
    act(() => {
      source.emit("error", 8, { message: "Your OpenAI account is out of credit." });
    });
    expect(result.current).toMatchObject({
      stalled: true,
      error: "Your OpenAI account is out of credit.",
    });
    act(() => {
      source.emit("activity", 9, { id: "a1", label: "Thinking…", detail: null, state: "running" });
    });
    expect(result.current).toMatchObject({ stalled: false, error: null });
  });
});

describe("a failed lesson", () => {
  const step = (id: string) => ({ id, heading: [], body: [], check: null });
  const check = (id: string, stepId: string) => ({
    id,
    stepId,
    role: "learner" as const,
    text: "an answer",
    blocks: null,
    verdict: null,
  });

  it("can be read up to its first missing step", () => {
    const lesson = { steps: [step("s1"), step("s3")], totalSteps: 3, failedSteps: [], notes: {} };
    expect(readableSteps(lesson).map((s) => s.id)).toEqual(["s1"]);
    expect(readableSteps(null)).toEqual([]);
  });

  it("drops the steps it writes again, with their threads and notes", async () => {
    serve(
      snapshot({
        lesson: {
          steps: [step("s1"), step("s3")],
          totalSteps: 3,
          failedSteps: [{ stepId: "s2", heading: "Two workers" }],
          notes: { s1: "kept", s3: "dropped" },
        },
        checks: [check("c1", "s1"), check("c3", "s3")],
      }),
    );
    const { result } = await renderModel();
    act(() => {
      openStream().emit("lesson-again", 8, { keep: ["s1"], totalSteps: 3 });
    });
    expect(result.current?.lesson).toEqual({
      steps: [step("s1")],
      totalSteps: 3,
      failedSteps: [],
      notes: { s1: "kept" },
    });
    expect(result.current?.checks.map((c) => c.id)).toEqual(["c1"]);
  });
});
