import type { Node } from "unist";

/** The source line a node starts on, spread into an Issue. */
export function lineOf(node: Node): { line?: number } {
  return node.position ? { line: node.position.start.line } : {};
}
