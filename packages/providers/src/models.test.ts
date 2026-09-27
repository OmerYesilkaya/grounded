import { describe, expect, it } from "vitest";
import { MODELS, cheapModelFor, estimateCost, offeredModels } from "./index.js";

describe("model list", () => {
  it("has unique ids, and a cheap model for every provider that offers any", () => {
    expect(new Set(MODELS.map((m) => m.id)).size).toBe(MODELS.length);
    for (const provider of ["anthropic", "openai", "google"] as const) {
      if (offeredModels(provider, { includeUngated: true }).length > 0) {
        expect(cheapModelFor(provider)).toBeDefined();
      }
    }
  });

  it("offers only evaluated models unless ungated ones are allowed", () => {
    const gated = offeredModels("anthropic", { includeUngated: false }).map((m) => m.id);
    const all = offeredModels("anthropic", { includeUngated: true }).map((m) => m.id);
    expect(gated).toEqual(
      MODELS.filter((m) => m.provider === "anthropic" && m.gate !== "pending").map((m) => m.id),
    );
    expect(all.length).toBeGreaterThanOrEqual(gated.length);
    expect(offeredModels("openai", { includeUngated: false }).map((m) => m.id)).toContain(
      "gpt-6-luna",
    );
  });

  it("estimates cost from token usage, or null when the price is unknown", () => {
    // Opus 5.5: $4 in, $20 out, $0.20 cached read per million tokens.
    expect(
      estimateCost("claude-opus-5-5", {
        inputTokens: 1_000_000,
        cachedInputTokens: 500_000,
        outputTokens: 100_000,
      }),
    ).toBeCloseTo(0.5 * 4 + 0.5 * 0.2 + 0.1 * 20);
    expect(
      estimateCost("gpt-6-luna", { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 }),
    ).toBeNull();
    expect(
      estimateCost("no-such-model", { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }),
    ).toBeNull();
  });
});
