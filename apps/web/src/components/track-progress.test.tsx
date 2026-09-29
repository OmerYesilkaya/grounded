import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { Idea, TrackProgress } from "@/lib/progress";
import type { SessionItem } from "@/lib/tracks";
import { TrackProgressView } from "./track-progress";

vi.mock("@tanstack/react-router", () => ({
  Link: (props: { to: string; params?: Record<string, string>; children: ReactNode }) => (
    <a href={props.to.replace("$sessionId", props.params?.sessionId ?? "")}>{props.children}</a>
  ),
}));
vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const idea = (term: string, fields: Partial<Idea> = {}): Idea => ({
  term,
  standing: "owned",
  brought: false,
  restsOn: [],
  since: "2026-09-20T10:00:00.000Z",
  evidence: "",
  session: null,
  ...fields,
});

const progress: TrackProgress = {
  owned: [
    idea("working copy", { evidence: "Each thread copies the number, adds one, writes it back." }),
    idea("number", { brought: true }),
  ],
  settling: [
    idea("lost update", {
      standing: "settling",
      restsOn: ["working copy"],
      evidence: "One of the writes just disappears?",
      session: { id: "s2", number: 2 },
    }),
  ],
  coming: 1,
  revisit: ["Thinks adding one is a single step"],
  arcs: [
    {
      title: "Concurrency",
      current: true,
      counts: { owned: 2, settling: 1, coming: 1 },
      map: { nodes: [], edges: [] },
    },
  ],
};

const done = (number: number): SessionItem => ({
  kind: "session",
  id: `s${String(number)}`,
  done: true,
  activeAt: "2026-09-20T10:00:00.000Z",
  number,
  phase: "closed",
  terms: [],
  lessonTitle: null,
});

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TrackProgressView trackId="t1" items={[done(1), done(2)]} />
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.mocked(api).mockResolvedValue(progress);
  Element.prototype.scrollIntoView = vi.fn();
});

describe("a track's progress (design §8)", () => {
  it("counts what is owned, what is settling and the sessions done", async () => {
    show();
    const figures = await screen.findAllByRole("definition");
    expect(figures.map((f) => f.textContent)).toEqual(["2", "1", "2"]);
    expect(screen.getByText("sessions done")).toBeTruthy();
    expect(screen.getByText("Thinks adding one is a single step")).toBeTruthy();
  });

  it("opens an idea in plain words: the words that showed it and where it happened", async () => {
    show();
    await userEvent.click(await screen.findByRole("button", { name: "lost update" }));
    expect(screen.getByText("You have met it; it isn't solid yet.")).toBeTruthy();
    expect(screen.getByText("One of the writes just disappears?")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Session 2" }).getAttribute("href")).toBe(
      "/sessions/s2",
    );
    expect(screen.getByText(/rests on working copy/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /number/ }));
    expect(screen.getByText("You already knew it when this track began.")).toBeTruthy();
  });

  it("never uses the method's words for where an idea stands", async () => {
    const { container } = show();
    await userEvent.click(await screen.findByRole("button", { name: "lost update" }));
    expect(container.textContent).not.toMatch(/confirmed|taught|assumed|planned/i);
  });
});
