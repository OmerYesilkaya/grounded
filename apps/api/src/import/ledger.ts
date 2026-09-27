import type { TermStatus } from "@grounded/db";

/**
 * The earlier setup's ledger (state.md's `## Ledger`), read without a model: four `### ` sections,
 * each naming terms with a status. Assumed and Planned are " · "-separated lists running across
 * lines; Confirmed and Taught are markdown tables whose first column is the term.
 */
export interface LedgerEntry {
  /** The row's or item's own wording, markdown bold removed. */
  term: string;
  status: TermStatus;
  /** Why it has that status, in the ledger's words; empty for a planned item without context. */
  evidence: string;
}

export interface Ledger {
  /** Every row and item, section by section, before duplicates are merged. */
  entries: LedgerEntry[];
  /** Entries per section, as parsed. */
  counts: Record<TermStatus, number>;
  /** Lines the parser couldn't classify, quoted, for the review. */
  skipped: string[];
}

export const ASSUMED_EVIDENCE = "Held before teaching (probe)";

const STATUSES = ["assumed", "confirmed", "taught", "planned"] as const;

export function parseLedger(body: string): Ledger {
  const entries: LedgerEntry[] = [];
  const skipped: string[] = [];
  let status: TermStatus | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (status === null) {
      for (const line of lines)
        if (line.trim()) skipped.push(`Ledger line outside a section: ${line.trim()}`);
    } else if (status === "confirmed" || status === "taught") {
      entries.push(...tableEntries(lines, status, skipped));
    } else {
      entries.push(...listEntries(lines, status));
    }
  };
  for (const line of body.split("\n")) {
    const heading = /^###\s+(.+)$/.exec(line);
    if (!heading?.[1]) {
      lines.push(line);
      continue;
    }
    flush();
    lines = [];
    const word = /^\w+/.exec(heading[1])?.[0]?.toLowerCase();
    status = STATUSES.find((s) => s === word) ?? null;
    if (status === null) skipped.push(`Ledger section not understood: ### ${heading[1].trim()}`);
  }
  flush();

  const counts: Record<TermStatus, number> = { assumed: 0, confirmed: 0, taught: 0, planned: 0 };
  for (const entry of entries) counts[entry.status]++;
  return { entries, counts, skipped };
}

/** A table's rows until the next heading; blank lines inside it don't end it. */
function tableEntries(lines: string[], status: TermStatus, skipped: string[]): LedgerEntry[] {
  const rows: string[][] = [];
  let previousWasRow = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      if (trimmed) skipped.push(`Not a table row under ${status}: ${trimmed}`);
      previousWasRow = false;
      continue;
    }
    const cells = cellsOf(trimmed);
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) {
      // A separator row: the row above it was the header.
      if (previousWasRow) rows.pop();
      previousWasRow = false;
      continue;
    }
    rows.push(cells);
    previousWasRow = true;
  }
  const entries: LedgerEntry[] = [];
  for (const [first, ...rest] of rows) {
    const term = cleanTerm(first ?? "");
    if (!term) {
      skipped.push(`A ${status} row without a term: | ${rest.join(" | ")} |`);
      continue;
    }
    entries.push({ term, status, evidence: rest.filter(Boolean).join("; ") });
  }
  return entries;
}

function cellsOf(row: string): string[] {
  return row
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, "|").trim());
}

/**
 * A " · "-separated list across lines. A label at the start of an item ("**B1 probe floors:**",
 * "from S6:") is context for the items that start on the same line: kept as evidence, not in the name.
 * Within such a note, items are separated by semicolons.
 * A parenthesised group with a label, "(arc B remaining: a, b, c)", is a list of its own.
 */
function listEntries(lines: string[], status: TermStatus): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  let context: { line: number; text: string } | null = null;
  for (const item of splitItems(lines)) {
    let text = item.text;
    const label = /^\*\*(.+?):\*\*\s*/.exec(text) ?? /^(from [^:()·]{1,40}):\s+/i.exec(text);
    if (label?.[1]) {
      context = { line: item.line, text: label[1].trim() };
      text = text.slice(label[0].length);
    } else if (context && context.line !== item.line) {
      context = null;
    }
    const group = /^\(([^():]+):\s*(.+)\)$/.exec(text);
    // A labelled note lists its items with semicolons; elsewhere a semicolon is part of the item.
    const names = group?.[2]
      ? splitTopLevel(group[2], ",")
      : context
        ? splitTopLevel(text, ";")
        : [text];
    const notes = [context?.text, group?.[1]?.trim()].filter((n): n is string => Boolean(n));
    for (const name of names) {
      const term = cleanTerm(name);
      if (!term) continue;
      const note = notes.join("; ");
      const evidence =
        status === "assumed" ? [ASSUMED_EVIDENCE, note].filter(Boolean).join(" — ") : note;
      entries.push({ term, status, evidence });
    }
  }
  return entries;
}

/** Items separated by "·" outside parentheses; an item may run onto the next line. */
function splitItems(lines: string[]): { text: string; line: number }[] {
  const items: { text: string; line: number }[] = [];
  let current = "";
  let start = 0;
  let depth = 0;
  const end = () => {
    if (current.trim()) items.push({ text: current.trim(), line: start });
    current = "";
  };
  lines.forEach((line, lineNumber) => {
    for (const char of line) {
      if (depth === 0 && char === "·") {
        end();
        continue;
      }
      if (char === "(") depth++;
      if (char === ")") depth = Math.max(0, depth - 1);
      if (!current.trim() && char.trim()) start = lineNumber;
      current += char;
    }
    current += " ";
  });
  end();
  return items;
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of text) {
    if (char === "(") depth++;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && char === separator) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function cleanTerm(text: string): string {
  return text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

/** A term once, with its strongest status; the other sections' evidence is appended to its own. */
export interface LedgerTerm extends LedgerEntry {
  /** The other sections it was also listed in. */
  alsoIn: TermStatus[];
}

const STRENGTH: Record<TermStatus, number> = { confirmed: 3, taught: 2, assumed: 1, planned: 0 };

/** One term per name (case-insensitive), in the order the names first appear. */
export function mergeLedger(entries: readonly LedgerEntry[]): LedgerTerm[] {
  const groups = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    const key = entry.term.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.values()].map((group) => {
    const [strongest, ...others] = [...group].sort(
      (a, b) => STRENGTH[b.status] - STRENGTH[a.status],
    );
    if (!strongest) throw new Error("empty ledger group");
    const evidence = [
      strongest.evidence,
      ...others.map((o) => `also listed as ${o.status}${o.evidence ? `: ${o.evidence}` : ""}`),
    ]
      .filter(Boolean)
      .join("; ");
    return { ...strongest, evidence, alsoIn: others.map((o) => o.status) };
  });
}
