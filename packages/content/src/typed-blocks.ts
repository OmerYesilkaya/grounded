import type { Code } from "mdast";
import type { ContainerDirective, LeafDirective } from "mdast-util-directive";
import type { Node } from "unist";
import { lineOf } from "./position.js";
import type { Block, DiagramFrame, Issue } from "./types.js";

type Report = (code: string, message: string) => void;

/** Trimmed text, or null when absent or blank. */
function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed;
}

function reporter(issues: Issue[], id: string, node: Node): Report {
  return (code, message) => {
    issues.push({ code, message, blockId: id, ...lineOf(node) });
  };
}

/** Splits "key: value" header lines from the body at the first line that is exactly "---". */
function splitHeader(text: string): { header: string[]; body: string } | null {
  const lines = text.split("\n");
  const sep = lines.findIndex((line) => line.trim() === "---");
  if (sep === -1) return null;
  return {
    header: lines.slice(0, sep),
    body: lines
      .slice(sep + 1)
      .join("\n")
      .trim(),
  };
}

function readHeader(
  lines: string[],
  allowed: readonly string[],
  kind: string,
  report: Report,
): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = /^([a-z]+):\s*(.*)$/.exec(line.trim());
    const key = match?.[1];
    if (!match || key === undefined || !allowed.includes(key)) {
      report(
        `${kind}/unknown-key`,
        `Unknown ${kind} header line "${line.trim()}". Allowed: ${allowed.map((k) => `"${k}:"`).join(", ")}.`,
      );
      continue;
    }
    values.set(key, match[2] ?? "");
  }
  return values;
}

function parseFrame(text: string, report: Report, where = ""): DiagramFrame | null {
  const parts = splitHeader(text);
  if (!parts) {
    report(
      "diagram/missing-separator",
      `${where}A diagram starts with a "caption:" line, then a line "---", then the Mermaid source.`,
    );
    return null;
  }
  const header = readHeader(parts.header, ["caption", "highlight"], "diagram", report);
  const caption = header.get("caption")?.trim();
  let ok = true;
  if (!caption) {
    report(
      "diagram/missing-caption",
      `${where}A diagram needs a "caption:" line stating the one claim it makes.`,
    );
    ok = false;
  }
  if (!parts.body) {
    report("diagram/empty-source", `${where}The diagram has no Mermaid source after "---".`);
    ok = false;
  }
  if (!ok || !caption) return null;
  const highlight = header.get("highlight")?.trim();
  return { caption, syntax: "mermaid", source: parts.body, ...(highlight ? { highlight } : {}) };
}

/** Fenced code whose language names one of our block types; anything else is ordinary code. */
export function convertTypedCode(
  node: Code,
  id: string,
  issues: Issue[],
): Block | null | undefined {
  const report = reporter(issues, id, node);
  switch (node.lang) {
    case "diagram": {
      const frame = parseFrame(node.value, report);
      if (!frame) return null;
      const { caption, syntax, source, highlight } = frame;
      return { id, type: "diagram", syntax, caption, highlight: highlight ?? null, source };
    }
    case "stepper": {
      const texts = node.value.split(/^--- frame\s*$/m);
      const frames: DiagramFrame[] = [];
      let broken = false;
      for (const [i, text] of texts.entries()) {
        const frame = parseFrame(text.trim(), report, `Frame ${String(i + 1)}: `);
        if (frame)
          frames.push({ caption: frame.caption, syntax: frame.syntax, source: frame.source });
        else broken = true;
      }
      if (broken) return null;
      if (frames.length < 2) {
        report(
          "stepper/too-few-frames",
          'A stepper needs at least two frames, separated by a line "--- frame". Use a diagram for a single picture.',
        );
        return null;
      }
      return { id, type: "stepper", frames };
    }
    case "chart": {
      const parts = splitHeader(node.value);
      const header = parts
        ? readHeader(parts.header, ["source"], "chart", report)
        : new Map<string, string>();
      const json = parts ? parts.body : node.value;
      let spec: unknown;
      try {
        spec = JSON.parse(json);
      } catch (error) {
        report(
          "chart/invalid-json",
          `The chart spec is not valid JSON: ${(error as Error).message}`,
        );
        return null;
      }
      if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
        report("chart/not-an-object", "The chart spec must be a Vega-Lite JSON object.");
        return null;
      }
      return {
        id,
        type: "chart",
        spec: spec as Record<string, unknown>,
        source: nonEmpty(header.get("source")),
      };
    }
    default:
      return undefined;
  }
}

const unknownBlock = (name: string) =>
  `There is no "${name}" block. Allowed blocks are listed in your instructions.`;

export function convertLeafDirective(
  node: LeafDirective,
  id: string,
  issues: Issue[],
): Block | null {
  const report = reporter(issues, id, node);
  const attrs = node.attributes ?? {};
  const need = (kind: string, ...names: string[]): string[] | null => {
    const values: string[] = [];
    for (const name of names) {
      const value = attrs[name]?.trim();
      if (!value) {
        report(`${kind}/missing-attribute`, `A ${kind} block needs an "${name}" attribute.`);
        return null;
      }
      values.push(value);
    }
    return values;
  };
  const caption = nonEmpty(attrs.caption);

  switch (node.name) {
    case "video": {
      const got = need("video", "id");
      if (!got) return null;
      const time = (name: "start" | "end"): number | null | false => {
        const raw = attrs[name]?.trim();
        if (!raw) return null;
        const seconds = Number(raw);
        if (!Number.isFinite(seconds) || seconds < 0) {
          report(
            "video/invalid-time",
            `The video's "${name}" must be a number of seconds, not "${raw}".`,
          );
          return false;
        }
        return seconds;
      };
      const start = time("start");
      const end = time("end");
      if (start === false || end === false) return null;
      return { id, type: "video", provider: "youtube", videoId: got[0] ?? "", start, end, caption };
    }
    case "image":
    case "audio": {
      const got = need(node.name, "ref");
      if (!got) return null;
      return { id, type: node.name, ref: got[0] ?? "", caption, file: null };
    }
    case "link": {
      const got = need("link", "url", "title", "why");
      if (!got) return null;
      const [url = "", title = "", why = ""] = got;
      return { id, type: "link", url, title, why };
    }
    default:
      report("unknown-block", unknownBlock(node.name));
      return null;
  }
}

export function convertContainerDirective(
  node: ContainerDirective,
  id: string,
  issues: Issue[],
  convertChildren: (prefix: string) => Block[],
): Block | null {
  const report = reporter(issues, id, node);
  if (node.name !== "check") {
    report("unknown-block", unknownBlock(node.name));
    return null;
  }
  const children = convertChildren(`${id}.`);
  if (children.length === 0) {
    report("check/empty", "A check needs its question inside it.");
    return null;
  }
  return { id, type: "check", children };
}
