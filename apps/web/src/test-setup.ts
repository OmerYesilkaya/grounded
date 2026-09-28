import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// The Lottie player reaches for a canvas as soon as it loads, which jsdom has none of. Tests assert
// on text, not on how the working mark moves, so it plays nothing here.
vi.mock("lottie-web/build/player/lottie_light", () => ({
  default: {
    loadAnimation: () => ({
      addEventListener: () => undefined,
      destroy: () => undefined,
      play: () => undefined,
      setSpeed: () => undefined,
      goToAndPlay: () => undefined,
      goToAndStop: () => undefined,
    }),
  },
}));

afterEach(() => {
  cleanup();
});
