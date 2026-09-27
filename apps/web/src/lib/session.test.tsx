import { initialSession } from "@grounded/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionModel, type SessionModel } from "./session";

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

function snapshot(overrides: Partial<SessionModel> = {}): Omit<SessionModel, "error"> {
  return {
    id: SESSION_ID,
    trackId: "0190c2a0-0000-7000-8000-000000000002",
    state: initialSession(),
    messages: [],
    lesson: null,
    checks: [],
    lastEventId: 7,
    ...overrides,
  };
}

function serve(body: Omit<SessionModel, "error">) {
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
