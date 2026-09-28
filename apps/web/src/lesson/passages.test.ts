import { beforeEach, describe, expect, it } from "vitest";
import { placeCards } from "./aside-layout";
import { anchorOf, bestMatch, findPassage } from "./passages";

let lesson: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = `
    <article>
      <section data-step="s1">
        <h2 data-block="s1.b1">Three moves</h2>
        <p data-block="s1.b2">The value is copied out, changed, and <em>put back</em>.</p>
        <p data-block="s1.b3">It is copied out again later.</p>
        <div><button>I don't know</button><p data-block="b1">A reply in the check's thread.</p></div>
      </section>
      <section data-step="s2"><p data-block="s2.b2">Two workers both copy 5.</p></section>
    </article>`;
  const article = document.querySelector("article");
  if (!article) throw new Error("no lesson");
  lesson = article;
});

const text = (selector: string) => {
  const node = document.querySelector(selector)?.firstChild;
  if (!(node instanceof Text)) throw new Error(`no text in ${selector}`);
  return node;
};

function rangeOver(start: [Text, number], end: [Text, number]): Range {
  const range = document.createRange();
  range.setStart(...start);
  range.setEnd(...end);
  return range;
}

describe("the anchor of a selection", () => {
  it("is the passage's block, its words and the text around them", () => {
    const p = text('[data-block="s1.b2"]');
    const selected = anchorOf(lesson, rangeOver([p, 12], [p, 23]));
    expect(selected?.stepId).toBe("s1");
    expect(selected?.anchor).toEqual({
      blockId: "s1.b2",
      quote: "copied out",
      prefix: "Three moves\nThe value is ",
      suffix: ", changed, and put back.\nIt is copied out again later.",
    });
  });

  it("runs across blocks with a line break between them, and skips the page's own text", () => {
    const put = text('[data-block="s1.b2"] em');
    const later = text('[data-block="s1.b3"]');
    const selected = anchorOf(lesson, rangeOver([put, 0], [later, 5]));
    expect(selected?.anchor.quote).toBe("put back.\nIt is");
    const reply = text('[data-block="b1"]');
    expect(anchorOf(lesson, rangeOver([reply, 0], [reply, 7]))).toBeNull();
  });

  it("stays within one step", () => {
    const first = text('[data-block="s1.b3"]');
    const second = text('[data-block="s2.b2"]');
    expect(anchorOf(lesson, rangeOver([first, 0], [second, 3]))).toBeNull();
  });
});

describe("finding a passage again", () => {
  it("picks the occurrence whose surroundings match", () => {
    const later = findPassage(lesson, "s1", {
      blockId: "s1.b3",
      quote: "copied out",
      prefix: "It is ",
      suffix: " again",
    });
    expect(later?.startContainer).toBe(text('[data-block="s1.b3"]'));
    expect(later?.toString()).toBe("copied out");
  });

  it("looks in the whole step when its block has changed, and gives up when it is gone", () => {
    const moved = findPassage(lesson, "s1", {
      blockId: "s1.b9",
      quote: "put back",
      prefix: "changed, and ",
      suffix: ".",
    });
    expect(moved?.toString()).toBe("put back");
    expect(
      findPassage(lesson, "s1", { blockId: "s1.b2", quote: "gone", prefix: "", suffix: "" }),
    ).toBeNull();
  });

  it("survives a note added nearby", () => {
    const anchor = { blockId: "s1.b3", quote: "again", prefix: "copied out ", suffix: " later" };
    const note = document.createElement("div");
    note.textContent = "After the check: again and again.";
    document
      .querySelector('[data-step="s1"]')
      ?.insertBefore(note, document.querySelector('[data-block="s1.b3"]'));
    expect(findPassage(lesson, "s1", anchor)?.startContainer).toBe(text('[data-block="s1.b3"]'));
  });

  it("scores by how much of the text before and after agrees", () => {
    expect(bestMatch("a x b x c", { quote: "x", prefix: "b ", suffix: " c" })).toBe(6);
    expect(bestMatch("a x b", { quote: "y", prefix: "", suffix: "" })).toBe(-1);
  });
});

describe("placing cards in the margin", () => {
  it("keeps them by their passages without overlapping", () => {
    const tops = placeCards(
      [
        { id: "b", want: 120, height: 80 },
        { id: "a", want: 100, height: 50 },
        { id: "c", want: 400, height: 40 },
      ],
      null,
    );
    expect(Object.fromEntries(tops)).toEqual({ a: 100, b: 160, c: 400 });
  });

  it("puts the active card by its passage and moves the ones above it up", () => {
    const tops = placeCards(
      [
        { id: "a", want: 100, height: 50 },
        { id: "b", want: 120, height: 80 },
        { id: "c", want: 150, height: 40 },
      ],
      "b",
    );
    expect(Object.fromEntries(tops)).toEqual({ a: 60, b: 120, c: 210 });
  });
});
