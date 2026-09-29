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

// The answer editors (ProseMirror) measure where the selection is to keep it in view; jsdom lays
// nothing out, so every box is empty and at the origin.
const noRects = () => [] as unknown as DOMRectList;
const noRect = () => new DOMRect();
for (const proto of [Range.prototype, Element.prototype, Text.prototype] as object[]) {
  if (!("getClientRects" in proto)) Object.assign(proto, { getClientRects: noRects });
  if (!("getBoundingClientRect" in proto)) Object.assign(proto, { getBoundingClientRect: noRect });
}
if (!("elementFromPoint" in document)) Object.assign(document, { elementFromPoint: () => null });

afterEach(() => {
  cleanup();
});
