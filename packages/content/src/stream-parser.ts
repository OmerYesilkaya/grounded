import { convertNodes, parseMarkdown, type ParseOptions } from "./parse-blocks.js";
import type { Issue, ParseResult } from "./types.js";

export interface StreamParser {
  /** Adds streamed text; returns the blocks completed by it, each exactly once, in order. */
  push(chunk: string): ParseResult;
  /** Ends the stream; returns whatever was still held back. */
  end(): ParseResult;
}

/**
 * Releases a block only once the next block has started, so a learner never sees half a paragraph,
 * an unclosed check or a diagram whose source is still arriving. Ids and issues match parseBlocks on
 * the whole text. It re-parses the buffer on each push: the worker batches chunks, and a lesson is
 * tens of kilobytes, so this stays cheap and keeps the parser's behaviour identical to parseBlocks.
 */
export function createStreamParser(options: ParseOptions = {}): StreamParser {
  const idPrefix = options.idPrefix ?? "b";
  let buffer = "";
  let released = 0;
  let ended = false;

  const release = (upTo: (count: number) => number): ParseResult => {
    const nodes = parseMarkdown(buffer).children;
    const end = upTo(nodes.length);
    const issues: Issue[] = [];
    const blocks = convertNodes(nodes.slice(released, end), idPrefix, issues, released + 1);
    released = Math.max(released, end);
    return { blocks, issues };
  };

  return {
    push(chunk) {
      if (ended) return { blocks: [], issues: [] };
      buffer += chunk;
      return release((count) => count - 1);
    },
    end() {
      if (ended) return { blocks: [], issues: [] };
      ended = true;
      return release((count) => count);
    },
  };
}
