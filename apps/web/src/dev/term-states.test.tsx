import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { TrackSummary } from "@/lib/tracks";
import { TermStates, type RawTerm } from "./term-states";

const page: { params: Record<string, string> } = { params: {} };
vi.mock("@tanstack/react-router", () => ({ useParams: () => page.params }));
vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const tracks: TrackSummary[] = [
  {
    id: "t1",
    title: "Concurrency",
    naming: false,
    language: null,
    activeAt: "2026-09-20T10:00:00.000Z",
    items: [
      {
        kind: "session",
        id: "s1",
        done: false,
        activeAt: "2026-09-20T10:00:00.000Z",
        number: 1,
        phase: "lesson",
        terms: [],
        lessonTitle: null,
        final: false,
      },
    ],
    openSession: null,
    finishedIn: null,
    files: [],
    source: null,
    reading: null,
    importedLesson: null,
  } as unknown as TrackSummary,
];

const terms: RawTerm[] = [
  {
    term: "working copy",
    status: "confirmed",
    borrowedFrom: null,
    restsOn: [],
    events: [
      {
        from: null,
        to: "planned",
        evidence: "",
        source: "plan",
        at: "2026-09-20T10:00:00.000Z",
      },
      {
        from: "planned",
        to: "taught",
        evidence: "",
        source: "lesson s1",
        at: "2026-09-20T10:10:00.000Z",
      },
      {
        from: "taught",
        to: "confirmed",
        evidence: "Each thread copies the number.",
        source: "check s1",
        at: "2026-09-20T10:20:00.000Z",
      },
    ],
  },
  {
    term: "lost update",
    status: "planned",
    borrowedFrom: null,
    restsOn: ["working copy"],
    events: [
      { from: null, to: "planned", evidence: "", source: "plan", at: "2026-09-20T10:00:00.000Z" },
    ],
  },
  {
    term: "thread",
    status: "confirmed",
    borrowedFrom: "Operating systems",
    restsOn: [],
    events: [],
  },
];

const session = {
  state: {
    phase: "lesson",
    currentStep: "s2",
    lesson: {
      status: "ready",
      steps: [
        { id: "s1", check: { steps: ["s1"], terms: ["working copy"], gates: true } },
        { id: "s2", check: null },
      ],
    },
    steps: { s1: { status: "settling", misses: 1, offerGate: false } },
  },
};

const chord = () =>
  fireEvent.keyDown(window, { code: "KeyT", key: "ˇ", altKey: true, shiftKey: true });

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TermStates />
    </QueryClientProvider>,
  );

beforeEach(() => {
  page.params = { trackId: "t1" };
  vi.mocked(api).mockImplementation((path: string) => {
    if (path === "/api/tracks") return Promise.resolve(tracks);
    if (path === "/api/dev/tracks/t1/terms") return Promise.resolve({ terms });
    if (path === "/api/sessions/s1") return Promise.resolve(session);
    return Promise.reject(new Error(`unexpected ${path}`));
  });
});

describe("the development view of a track's terms (design §10)", () => {
  it("opens on the chord with the method's statuses, and closes on it again", async () => {
    show();
    expect(screen.queryByText("Terms as stored")).toBeNull();
    chord();
    expect(await screen.findByText("Terms as stored")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "lost update" })).toBeTruthy();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      "working copyconfirmed—check s1 · Each thread copies the number.",
      "lost updateplannedworking copyplan",
      "threadconfirmedborrowed from Operating systems——",
    ]);
    expect(screen.getByText(/dev only · Concurrency/)).toBeTruthy();
    chord();
    expect(screen.queryByText("Terms as stored")).toBeNull();
  });

  it("opens a term's history", async () => {
    show();
    chord();
    await userEvent.click(await screen.findByRole("button", { name: "working copy" }));
    const history = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(history).toHaveLength(3);
    expect(history[0]).toMatch(/∅ → plannedplan$/);
    expect(history[2]).toMatch(/taught → confirmedcheck s1Each thread copies the number\.$/);
  });

  it("on a session page, finds the track from the session and shows each step's check", async () => {
    page.params = { sessionId: "s1" };
    show();
    chord();
    expect(await screen.findByText(/This session's steps · phase lesson/)).toBeTruthy();
    expect(screen.getByText("settling")).toBeTruthy();
    expect(screen.getByText("1 missed")).toBeTruthy();
    expect(screen.getByText("checks working copy · gates")).toBeTruthy();
    expect(screen.getByText("not reached")).toBeTruthy();
    expect(screen.getByText("current")).toBeTruthy();
  });

  it("ignores the letter without its modifiers", () => {
    show();
    fireEvent.keyDown(window, { code: "KeyT", key: "t" });
    fireEvent.keyDown(window, { code: "KeyT", key: "T", shiftKey: true });
    expect(screen.queryByText("Terms as stored")).toBeNull();
  });
});
