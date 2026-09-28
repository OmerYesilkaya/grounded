import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionItem, TrackSummary } from "@/lib/tracks";
import { TrackSidebar } from "./track-sidebar";

const page = vi.hoisted((): { params: { trackId?: string; sessionId?: string } } => ({
  params: {},
}));
const tracks = vi.hoisted(() => ({ data: [] as TrackSummary[] }));

vi.mock("@tanstack/react-router", () => ({
  useParams: () => page.params,
  useNavigate: () => vi.fn(),
  Link: (props: {
    to: string;
    params?: Record<string, string>;
    children: ReactNode;
    className?: string;
    "aria-current"?: "page" | "true";
    title?: string;
  }) => {
    const href = Object.entries(props.params ?? {}).reduce(
      (path, [key, value]) => path.replace(`$${key}`, value),
      props.to,
    );
    return (
      <a href={href} aria-current={props["aria-current"]} title={props.title}>
        {props.children}
      </a>
    );
  },
}));
vi.mock("@/lib/tracks", () => ({ useTracks: () => tracks }));
vi.mock("@/lib/auth-client", () => ({ authClient: {} }));

const session = (number: number, fields: Partial<SessionItem> = {}): SessionItem => ({
  kind: "session",
  id: `s${String(number)}`,
  number,
  phase: "closed",
  done: true,
  terms: [],
  activeAt: "2026-09-29T00:00:00.000Z",
  ...fields,
});

const track = (id: string, title: string, items: SessionItem[] = []): TrackSummary => {
  const open = items.find((item) => !item.done);
  return {
    id,
    title,
    naming: false,
    language: "English",
    activeAt: "2026-09-29T00:00:00.000Z",
    items,
    openSession: open ? { id: open.id, phase: open.phase } : null,
    importedLesson: null,
    files: [],
  };
};

const software = () =>
  track("t1", "How software works", [
    session(1, { terms: ["bit", "byte"] }),
    session(2, { terms: ["memory address"] }),
    session(3, {
      id: "open",
      phase: "lesson",
      done: false,
      terms: ["working copy", "lost update"],
    }),
  ]);

beforeEach(() => {
  page.params = {};
  tracks.data = [];
});

const trackNamed = (name: string) =>
  screen.getByRole("link", { name }).closest("li") as HTMLElement;

describe("the track list", () => {
  it("hangs the page's track's items under it, the session on the page marked", () => {
    tracks.data = [
      software(),
      track("t2", "Backend interviews", [session(1, { done: false, phase: "probe", id: "b1" })]),
    ];
    page.params = { sessionId: "open" };
    render(<TrackSidebar email="ada@example.com" />);

    const items = within(screen.getByRole("list", { name: "In How software works" }));
    const current = items.getByRole("link", { current: "page" });
    expect(current).toHaveTextContent("Working copy, lost updateSession 3 · lesson");
    expect(screen.getByRole("link", { name: "How software works" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    // Finished sessions fold into one line.
    expect(items.queryByText("Bit, byte")).not.toBeInTheDocument();
    expect(items.getByRole("button", { name: /2 done/ })).toHaveAttribute("aria-expanded", "false");

    // Another track is one line, saying what is waiting.
    expect(screen.queryByRole("list", { name: "In Backend interviews" })).not.toBeInTheDocument();
    expect(trackNamed("Backend interviews")).toHaveTextContent("1 open");
  });

  it("unfolds finished sessions, and opens another track's items on request", async () => {
    const user = userEvent.setup();
    tracks.data = [
      software(),
      track("t2", "Backend interviews", [session(1, { done: false, phase: "probe", id: "b1" })]),
    ];
    page.params = { trackId: "t1" };
    render(<TrackSidebar email="ada@example.com" />);

    await user.click(screen.getByRole("button", { name: /2 done/ }));
    const items = within(screen.getByRole("list", { name: "In How software works" }));
    expect(items.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Bit, byteSession 1",
      "Memory addressSession 2",
      "Working copy, lost updateSession 3 · lesson",
    ]);

    await user.click(screen.getByRole("button", { name: "Show what is in Backend interviews" }));
    expect(
      within(screen.getByRole("list", { name: "In Backend interviews" })).getByRole("link"),
    ).toHaveTextContent("Finding where you startSession 1");
  });
});
