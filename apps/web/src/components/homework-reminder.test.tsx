import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeworkItem, TrackSummary } from "@/lib/tracks";
import { HomeworkReminder } from "./homework-reminder";

const page = vi.hoisted((): { params: { assignmentId?: string } } => ({ params: {} }));
const tracks = vi.hoisted(() => ({ data: [] as TrackSummary[] }));

vi.mock("@tanstack/react-router", () => ({
  useParams: () => page.params,
  Link: (props: { to: string; params?: Record<string, string>; children: ReactNode }) => (
    <a href={props.to.replace("$assignmentId", props.params?.assignmentId ?? "")}>
      {props.children}
    </a>
  ),
}));
vi.mock("@/lib/tracks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tracks")>()),
  useTracks: () => tracks,
}));
vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

const homework = (id: string, due: string | null): HomeworkItem => ({
  kind: "homework",
  id,
  session: 2,
  title: `Two counters ${id}`,
  form: "explain",
  done: false,
  activeAt: "2026-09-29T00:00:00.000Z",
  due,
  foldedInto: null,
});

const withItems = (items: HomeworkItem[]): TrackSummary[] => [
  {
    id: "t1",
    title: "How software works",
    naming: false,
    language: "English",
    activeAt: "2026-09-29T00:00:00.000Z",
    items,
    openSession: null,
    final: "not-yet",
    finishedIn: null,
    importedLesson: null,
    files: [],
    source: null,
    reading: null,
  },
];

const hour = 60 * 60 * 1000;
const past = () => new Date(Date.now() - hour).toISOString();

beforeEach(() => {
  page.params = {};
  sessionStorage.clear();
});

describe("the homework reminder", () => {
  it("reminds of homework whose snooze ran out, until dismissed for the visit", async () => {
    const user = userEvent.setup();
    tracks.data = withItems([homework("h1", past()), homework("h2", past())]);
    const { unmount } = render(<HomeworkReminder />, { wrapper });
    const reminder = screen.getByRole("complementary", { name: "Homework due" });
    expect(reminder).toHaveTextContent("Two counters h1");
    expect(reminder).toHaveTextContent("How software works · session 2 · and 1 more due");
    expect(screen.getByRole("link", { name: "Open it" })).toHaveAttribute("href", "/homework/h1");

    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    unmount();
    render(<HomeworkReminder />, { wrapper });
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("stays quiet before its time, and on the homework's own page", () => {
    const due = past();
    tracks.data = withItems([homework("h1", new Date(Date.now() + hour).toISOString())]);
    const { rerender } = render(<HomeworkReminder />, { wrapper });
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    tracks.data = withItems([homework("h1", due)]);
    page.params = { assignmentId: "h1" };
    rerender(<HomeworkReminder />);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });
});
