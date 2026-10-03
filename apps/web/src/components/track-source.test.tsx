import type { SourceReading, SourceSectionView } from "@grounded/core/sources";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLanguage } from "@/i18n";
import { api } from "@/lib/api";
import { SourceCoverageView, SourceReadingCard } from "./track-source";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const reading = (fields: Partial<SourceReading>): SourceReading => ({
  status: "awaiting",
  pages: 340,
  transcribe: 40,
  transcribed: 0,
  sections: 28,
  summarized: 0,
  estimate: 0.42,
  failure: null,
  ...fields,
});

const wrap = (children: ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>);

beforeEach(() => {
  vi.mocked(api).mockResolvedValue(null);
});
afterEach(() => {
  vi.clearAllMocks();
  act(() => {
    setLanguage("en");
  });
  localStorage.clear();
});

describe("reading a source", () => {
  it("shows what reading will cost before anything is spent, and reads once told to", async () => {
    const user = userEvent.setup();
    wrap(<SourceReadingCard trackId="t1" reading={reading({})} />);
    const card = screen.getByRole("region", { name: "The source" });
    expect(card).toHaveTextContent("340 pages · 40 for your model to read · about 28 sections");
    expect(card).toHaveTextContent("Reading it costs about $0.42 on your key, once.");
    await user.click(screen.getByRole("button", { name: "Read it" }));
    expect(api).toHaveBeenCalledWith("/api/tracks/t1/source/read", { method: "POST" });
  });

  it("says when the cost isn't known, and when the source has no pages", () => {
    wrap(
      <SourceReadingCard
        trackId="t1"
        reading={reading({ estimate: null, pages: 0, transcribe: 0, sections: 4 })}
      />,
    );
    const card = screen.getByRole("region", { name: "The source" });
    expect(card).toHaveTextContent("about 4 sections");
    expect(card).not.toHaveTextContent("for your model to read");
    expect(card).toHaveTextContent("there is no estimate");
  });

  it("shows the reading's progress: the pages, then the sections", () => {
    const { rerender } = wrap(
      <SourceReadingCard trackId="t1" reading={reading({ status: "reading", transcribed: 10 })} />,
    );
    expect(
      screen.getByRole("progressbar", { name: "Reading pages: 10 of 40" }),
    ).toBeInTheDocument();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <SourceReadingCard
          trackId="t1"
          reading={reading({ status: "reading", transcribed: 40, summarized: 7 })}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.getByRole("progressbar", { name: "Mapping sections: 7 of 28" }),
    ).toBeInTheDocument();
  });

  it("says why reading stopped, and offers to try again where it can", async () => {
    const user = userEvent.setup();
    wrap(
      <SourceReadingCard
        trackId="t1"
        reading={reading({
          status: "failed",
          failure: { code: "source-needs-vision", pages: 3, model: "DeepSeek Flash" },
        })}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("DeepSeek Flash doesn't read PDFs");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(api).toHaveBeenCalledWith("/api/tracks/t1/source/read", { method: "POST" });
  });

  it("offers nothing to try again for a file that can't be read", () => {
    wrap(
      <SourceReadingCard
        trackId="t1"
        reading={reading({
          status: "failed",
          failure: { code: "source-unreadable", name: "book.epub" },
        })}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("book.epub couldn't be opened and read.");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("speaks Turkish when the app does", () => {
    act(() => {
      setLanguage("tr");
    });
    wrap(<SourceReadingCard trackId="t1" reading={reading({})} />);
    expect(screen.getByRole("button", { name: "Oku" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Kaynak" })).toHaveTextContent("340 sayfa");
  });
});

describe("how much of the source is covered", () => {
  const section = (n: number, status: SourceSectionView["status"], source = "networks.pdf") => ({
    n,
    source,
    title: `Chapter ${String(n)}`,
    pages: `pp. ${String(n * 10)}–${String(n * 10 + 9)}`,
    status,
  });

  it("counts the sections by where the track stands with them, and lists each", async () => {
    vi.mocked(api).mockResolvedValue({
      reading: reading({ status: "ready" }),
      sections: [
        section(1, "known"),
        section(2, "taught"),
        section(3, "planned"),
        section(4, "ahead"),
      ],
    });
    wrap(<SourceCoverageView trackId="t1" />);
    expect(
      await screen.findByText("1 taught · 1 you knew · 1 planned · 1 ahead"),
    ).toBeInTheDocument();
    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      "1Chapter 1pp. 10–19you knew this",
      "2Chapter 2pp. 20–29taught",
      "3Chapter 3pp. 30–39planned",
      "4Chapter 4pp. 40–49ahead",
    ]);
    expect(api).toHaveBeenCalledWith("/api/tracks/t1/source");
  });

  it("names each section's file when there are several, and folds a long list away", async () => {
    vi.mocked(api).mockResolvedValue({
      reading: reading({ status: "ready" }),
      sections: Array.from({ length: 20 }, (_, i) =>
        section(i + 1, "ahead", i < 10 ? "book.pdf" : "notes.md"),
      ),
    });
    wrap(<SourceCoverageView trackId="t1" />);
    const fold = await screen.findByText("Show all 20 sections");
    expect(fold.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("notes.md · pp. 200–209", { exact: true })).toBeInTheDocument();
  });
});
