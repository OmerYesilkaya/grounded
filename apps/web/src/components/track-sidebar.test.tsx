import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { SessionItem, TrackSummary } from "@/lib/tracks";
import { TrackSidebar } from "./track-sidebar";

const page = vi.hoisted((): { params: { trackId?: string; sessionId?: string } } => ({
  params: {},
}));
const tracks = vi.hoisted(() => ({ data: [] as TrackSummary[] }));
const navigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  useParams: () => page.params,
  useNavigate: () => navigate,
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
vi.mock("@/lib/api", () => ({ api: vi.fn(), ApiError: class ApiError extends Error {} }));

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);
vi.mock("@/lib/auth-client", () => ({ authClient: {} }));

const session = (number: number, fields: Partial<SessionItem> = {}): SessionItem => ({
  kind: "session",
  id: `s${String(number)}`,
  number,
  phase: "closed",
  done: true,
  terms: [],
  lessonTitle: null,
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
  vi.clearAllMocks();
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
    render(<TrackSidebar email="ada@example.com" />, { wrapper });

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
    render(<TrackSidebar email="ada@example.com" />, { wrapper });

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

describe("searching the track list", () => {
  const searchBox = () => screen.getByRole("searchbox", { name: "Search tracks and lessons" });

  it("is reached with /, filters live, opens the first find with Enter, and clears with Escape", async () => {
    const user = userEvent.setup();
    tracks.data = [software(), track("t2", "Backend interviews")];
    render(<TrackSidebar email="ada@example.com" />, { wrapper });

    await user.keyboard("/");
    expect(searchBox()).toHaveFocus();
    await user.keyboard("memory");
    expect(screen.queryByRole("link", { name: "Backend interviews" })).not.toBeInTheDocument();
    // A lesson found in a closed track shows under it, even though it is finished.
    const found = within(screen.getByRole("list", { name: "In How software works" }));
    expect(found.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Memory addressSession 2",
    ]);

    await user.keyboard("{Enter}");
    expect(navigate).toHaveBeenCalledWith({
      to: "/sessions/$sessionId",
      params: { sessionId: "s2" },
    });
    expect(searchBox()).toHaveValue("");

    await user.type(searchBox(), "nothing like it");
    expect(screen.getByText("Nothing matches “nothing like it”.")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(searchBox()).toHaveValue("");
    expect(screen.getByRole("link", { name: "Backend interviews" })).toBeInTheDocument();
  });

  it("leaves a / typed in a text box alone", async () => {
    const user = userEvent.setup();
    render(
      <>
        <textarea aria-label="Answer" />
        <TrackSidebar email="ada@example.com" />
      </>,
      { wrapper },
    );
    await user.type(screen.getByRole("textbox", { name: "Answer" }), "a/b");
    expect(screen.getByRole("textbox", { name: "Answer" })).toHaveValue("a/b");
    expect(searchBox()).not.toHaveFocus();
  });
});

describe("many tracks", () => {
  it("shows the six most recently active and the rest under “N more tracks”", async () => {
    const user = userEvent.setup();
    tracks.data = Array.from({ length: 16 }, (_, i) =>
      track(`t${String(i)}`, `Track ${String(i)}`),
    );
    render(<TrackSidebar email="ada@example.com" />, { wrapper });
    const names = () =>
      within(screen.getByRole("navigation", { name: "Tracks" }))
        .getAllByRole("link")
        .map((link) => link.textContent);

    expect(names()).toEqual(["Track 0", "Track 1", "Track 2", "Track 3", "Track 4", "Track 5"]);
    await user.click(screen.getByRole("button", { name: "10 more tracks" }));
    expect(names()).toHaveLength(16);
    await user.click(screen.getByRole("button", { name: "Fewer tracks" }));
    expect(names()).toHaveLength(6);

    // A search looks through all of them.
    await user.type(screen.getByRole("searchbox"), "track 12");
    expect(names()).toEqual(["Track 12"]);
  });
});

describe("deleting a track", () => {
  it("asks first, naming what goes, then deletes it and leaves its page", async () => {
    const user = userEvent.setup();
    vi.mocked(api).mockResolvedValue(undefined);
    tracks.data = [software(), track("t2", "Backend interviews")];
    page.params = { sessionId: "open" };
    render(<TrackSidebar email="ada@example.com" />, { wrapper });

    await user.click(screen.getByRole("button", { name: "How software works: more" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete track…" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Delete “How software works”?",
    });
    expect(dialog).toHaveTextContent("the files you brought");

    await user.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "How software works: more" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete track…" }));
    await user.click(await screen.findByRole("button", { name: "Delete track" }));
    expect(api).toHaveBeenCalledWith("/api/tracks/t1", { method: "DELETE" });
    await vi.waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({ to: "/" });
    });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
