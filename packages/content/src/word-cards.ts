import type { Block, Inline } from "./types.js";

/** Whether a word card's `term` names this term: its whole name, or its name up to a ":", "(" or ";". */
export function cardNames(card: string, term: string): boolean {
  const key = cardKey(card);
  return cardKey(term) === key || cardKey(term.split(/[:;(]/)[0] ?? "") === key;
}

/** Lowercased and without a plural "s", for comparing a card's word with a term. */
export function cardKey(word: string): string {
  return word
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/(?:es|s)$/, "");
}

/** The word cards in a block tree, in order, each with its definition as plain text. */
export function wordCards(blocks: readonly Block[]): { term: string; text: string }[] {
  return blocks.flatMap((block) => {
    if (block.type === "word") return [{ term: block.term, text: plainText(block.children) }];
    if (block.type === "list") return block.items.flatMap(wordCards);
    if (block.type === "quote" || block.type === "check") return wordCards(block.children);
    return [];
  });
}

function plainText(blocks: readonly Block[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "paragraph":
          return inlines(block.children);
        case "list":
          return block.items.map(plainText).join(" ");
        case "math":
          return `$${block.value}$`;
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join(" ");
}

function inlines(children: readonly Inline[]): string {
  return children
    .map((inline) => {
      switch (inline.type) {
        case "text":
        case "inlineCode":
          return inline.value;
        case "inlineMath":
          return `$${inline.value}$`;
        case "break":
          return " ";
        default:
          return inlines(inline.children);
      }
    })
    .join("");
}
