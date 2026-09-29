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
    for (const provider of ["anthropic", "openai", "google"] as const) {
      const gated = offeredModels(provider, { includeUngated: false });
      const all = offeredModels(provider, { includeUngated: true });
      expect(gated.every((m) => m.gate !== "pending" && m.roles.includes("strong"))).toBe(true);
      expect(all.map((m) => m.id)).toEqual(expect.arrayContaining(gated.map((m) => m.id)));
    }
    expect(offeredModels("anthropic", { includeUngated: false }).map((m) => m.id)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
    ]);
    expect(offeredModels("openai", { includeUngated: false }).map((m) => m.id)).toContain(
      "gpt-6-luna",
    );
    // Not yet tested by Omer: development only.
    expect(offeredModels("google", { includeUngated: false })).toEqual([]);
    expect(offeredModels("google", { includeUngated: true }).map((m) => m.id)).toEqual([
      "gemini-3.8-flash",
    ]);
    expect(cheapModelFor("google")?.id).toBe("gemini-3.5-flash-lite");
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
    // Written to the cache: $8 per million, twice the base input rate.
    expect(
      estimateCost("claude-opus-5-5", {
        inputTokens: 1_000_000,
        cachedInputTokens: 200_000,
        cacheWriteTokens: 300_000,
        outputTokens: 0,
      }),
    ).toBeCloseTo(0.5 * 4 + 0.2 * 0.2 + 0.3 * 8);
    expect(
      estimateCost("gpt-6-luna", { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 }),
    ).toBeNull();
    expect(
      estimateCost("no-such-model", { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }),
    ).toBeNull();
  });
});
