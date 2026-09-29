import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackSummary } from "@/lib/tracks";
import { api } from "@/lib/api";
import { ImportedLessonPage } from "./imported-lesson";
import { TrackPage } from "./track";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  Link: ({
    to,
    params,
    children,
    className,
  }: {
    to: string;
    params: { trackId: string };
    children: ReactNode;
    className?: string;
  }) => (
    <a href={to.replace("$trackId", params.trackId)} className={className}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/api", () => ({
  api: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

const HTML = "<!doctype html><title>SQL</title><script>alert(1)</script><p>Joins.</p>";

const track = (importedLesson: TrackSummary["importedLesson"]): TrackSummary => ({
  id: "t1",
  title: "How software works",
  naming: false,
  language: "English",
  activeAt: "2026-09-29T00:00:00.000Z",
  items: [],
  openSession: null,
  final: "not-yet",
  finishedIn: null,
  importedLesson,
  files: [],
});

function renderWithQueries(node: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  vi.mocked(api).mockReset();
});

describe("the imported last lesson", () => {
  it("is linked from the track page when the track has one", async () => {
    vi.mocked(api).mockResolvedValue([track({ title: "SQL as asking questions" })]);
    renderWithQueries(<TrackPage trackId="t1" />);

    const link = await screen.findByRole("link", {
      name: /Last lesson \(from your earlier setup\)/,
    });
    expect(link).toHaveAttribute("href", "/tracks/t1/last-lesson");
    expect(link).toHaveTextContent("SQL as asking questions");
  });

  it("isn't linked when there is none", async () => {
    vi.mocked(api).mockResolvedValue([track(null)]);
    renderWithQueries(<TrackPage trackId="t1" />);

    await screen.findByText("How software works");
    expect(screen.queryByText(/Last lesson/)).toBeNull();
  });

  it("renders the lesson as it was in a sandbox with no scripts and no same-origin access", async () => {
    vi.mocked(api).mockResolvedValue({ title: "SQL", source: "2026-09-25-sql", html: HTML });
    renderWithQueries(<ImportedLessonPage trackId="t1" />);

    const frame = await screen.findByTitle("SQL");
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/tracks/t1/imported-lesson");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame).toHaveAttribute("srcdoc", HTML);
  });
});
