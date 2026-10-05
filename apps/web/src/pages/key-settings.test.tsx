import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { KeySettingsPage } from "./key-settings";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/lib/api", async () => ({
  ...(await vi.importActual<typeof import("@/lib/api")>("@/lib/api")),
  api: vi.fn(),
}));

const MODELS = {
  anthropic: [{ id: "claude-opus-5-5", label: "Claude Opus 5.5" }],
  openai: [
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
    { id: "gpt-6-luna", label: "GPT-6 Luna" },
  ],
  google: [],
  deepseek: [],
};
const LUNA = { provider: "openai", model: "gpt-6-luna", keyHint: "3456", source: "own_key" };

beforeEach(() => {
  vi.mocked(api).mockImplementation((path: string, init?: RequestInit) => {
    if (path === "/api/models") return Promise.resolve(MODELS);
    if (path === "/api/credentials" && init?.method === "PATCH") {
      const { model } = JSON.parse(init.body as string) as { model: string };
      return Promise.resolve({ ...LUNA, model });
    }
    if (path === "/api/credentials") return Promise.resolve(LUNA);
    return Promise.reject(new Error(`unexpected ${path}`));
  });
});
afterEach(() => {
  vi.clearAllMocks();
});

/** Radix renders a hidden native select inside a form; the model card is one, so a change reaches it. */
const modelSelect = () => {
  const card = screen.getByRole("form", { name: "Your saved key" });
  const select = card.querySelector("select");
  if (!select) throw new Error("no native select in the saved-key card");
  return { card, select };
};

describe("the key settings page", () => {
  it("switches the model under the saved key without asking for the key again", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <KeySettingsPage />
      </QueryClientProvider>,
    );
    await screen.findByRole("form", { name: "Your saved key" });
    const { card, select } = modelSelect();
    expect(within(card).getByRole("combobox", { name: "Model" })).toHaveTextContent("GPT-6 Luna");
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["gpt-6.1-sol", "gpt-6-luna"]);

    fireEvent.change(select, { target: { value: "gpt-6.1-sol" } });

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith("/api/credentials", {
        method: "PATCH",
        body: JSON.stringify({ model: "gpt-6.1-sol" }),
      });
    });
    await waitFor(() => {
      expect(within(card).getByRole("combobox", { name: "Model" })).toHaveTextContent(
        "GPT-6.1 Sol",
      );
    });
    expect(api).not.toHaveBeenCalledWith(
      "/api/credentials",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(navigate).not.toHaveBeenCalled();
  });
});
