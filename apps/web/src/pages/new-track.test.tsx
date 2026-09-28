import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { NewTrackPage } from "./new-track";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const MB = 1024 * 1024;
const file = (name: string, size = 10, type = "") =>
  new File([new Uint8Array(size)], name, { type, lastModified: 1 });

function renderPage() {
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <NewTrackPage />
    </QueryClientProvider>,
  );
  const picker = view.container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!picker) throw new Error("no file picker");
  return { ...view, picker };
}

const box = () => screen.getByRole("textbox", { name: "What do you want to learn?" });
const createButton = () => screen.getByRole("button", { name: "Create track" });
const attached = () =>
  within(screen.getByRole("list", { name: "Attached files" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent);

beforeEach(() => {
  // jsdom has no object URLs.
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
  vi.mocked(api).mockResolvedValue({ id: "t1" });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("the new-track page", () => {
  it("creates the track from the words and the files, with ⌘/Ctrl+Enter", async () => {
    const user = userEvent.setup();
    const { picker } = renderPage();
    await user.type(box(), "Everything my CV says I know{Enter}Backend, mostly");
    await user.upload(picker, [file("cv.pdf", 2 * MB), file("whiteboard.png", 300 * 1024)]);
    expect(attached()).toEqual(["cv.pdf2.0 MB", "whiteboard.png300 KB"]);

    await user.type(box(), "{Control>}{Enter}{/Control}");
    expect(api).toHaveBeenCalledTimes(1);
    const [path, init] = vi.mocked(api).mock.calls[0] ?? [];
    expect(path).toBe("/api/tracks");
    const body = init?.body as FormData;
    expect(body.get("goal")).toBe("Everything my CV says I know\nBackend, mostly");
    expect(body.getAll("files").map((f) => (f as File).name)).toEqual(["cv.pdf", "whiteboard.png"]);
    await vi.waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({ to: "/tracks/$trackId", params: { trackId: "t1" } });
    });
  });

  it("shows why a file can't go, holds creating back, and lets it be removed", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { picker } = renderPage();
    await user.type(box(), "Spreadsheets");
    await user.upload(picker, [file("budget.xlsx"), file("scan.png", 6 * MB)]);
    expect(attached()).toEqual([
      expect.stringContaining("Only images, PDFs, Word documents and text files"),
      expect.stringContaining("Larger than 5 MB."),
    ]);
    expect(createButton()).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Remove budget.xlsx" }));
    await user.click(screen.getByRole("button", { name: "Remove scan.png" }));
    expect(screen.queryByRole("list", { name: "Attached files" })).toBeNull();
    expect(createButton()).toBeEnabled();
  });

  it("says when the files are too many together", async () => {
    const user = userEvent.setup();
    const { picker } = renderPage();
    await user.upload(
      picker,
      Array.from({ length: 9 }, (_, i) => file(`${String(i)}.png`)),
    );
    expect(screen.getByText("Attach at most 8 files.")).toBeInTheDocument();
  });

  it("keeps a file picked twice once", async () => {
    const user = userEvent.setup();
    const { picker } = renderPage();
    await user.upload(picker, file("cv.pdf"));
    await user.upload(picker, file("cv.pdf"));
    expect(attached()).toHaveLength(1);
  });

  it("takes files dropped on the box, and a picture pasted into it", () => {
    renderPage();
    const form = box().closest("form");
    if (!form) throw new Error("no form");
    const dropped = file("notes.md");
    fireEvent.dragOver(form, { dataTransfer: { types: ["Files"], files: [dropped] } });
    fireEvent.drop(form, { dataTransfer: { types: ["Files"], files: [dropped] } });
    expect(attached()).toEqual(["notes.md10 B"]);

    fireEvent.paste(box(), {
      clipboardData: { files: [file("image.png")], getData: () => "" },
    });
    expect(attached()).toEqual(["notes.md10 B", "image.png10 B"]);

    // Text pastes as text, even when a picture comes with it.
    fireEvent.paste(box(), {
      clipboardData: { files: [file("copied.png")], getData: () => "some words" },
    });
    expect(attached()).toHaveLength(2);
  });
});
