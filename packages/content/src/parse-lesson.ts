import type { RootContent } from "mdast";
import { convertNodes, parseMarkdown } from "./parse-blocks.js";
import { lineOf } from "./position.js";
import type { Block, Inline, Issue, LessonParseResult, LessonStep } from "./types.js";

const isStepHeading = (node: RootContent) => node.type === "heading" && node.depth === 2;

/**
 * Parses a whole lesson. Every step starts with a "##" heading and ends with exactly one check;
 * anything else is reported against that step so it alone can be regenerated.
 */
export function parseLesson(markdown: string): LessonParseResult {
  const nodes = parseMarkdown(markdown).children;
  const issues: Issue[] = [];
  if (nodes.length === 0) {
    return { steps: [], issues: [{ code: "lesson/empty", message: "The lesson is empty." }] };
  }

  const firstStep = nodes.findIndex(isStepHeading);
  const leading = firstStep === -1 ? nodes : nodes.slice(0, firstStep);
  const [firstLeading] = leading;
  if (firstLeading) {
    issues.push({
      code: "lesson/content-before-first-step",
      message:
        'A lesson starts with its first step\'s "##" heading; move or remove the text before it.',
      ...lineOf(firstLeading),
    });
  }

  const groups: RootContent[][] = [];
  for (const node of firstStep === -1 ? [] : nodes.slice(firstStep)) {
    if (isStepHeading(node)) groups.push([node]);
    else groups.at(-1)?.push(node);
  }

  const steps: LessonStep[] = [];
  groups.forEach((group, index) => {
    const stepId = `s${String(index + 1)}`;
    const stepIssues: Issue[] = [];
    const blocks = convertNodes(group, `${stepId}.b`, stepIssues);
    const step = toStep(stepId, blocks, stepIssues);
    issues.push(...stepIssues.map((issue) => ({ ...issue, stepId })));
    if (step && stepIssues.length === 0) steps.push(step);
  });

  return { steps, issues };
}

function toStep(id: string, blocks: Block[], issues: Issue[]): LessonStep | null {
  const [heading, ...rest] = blocks;
  if (heading?.type !== "heading") return null;
  const title = plainText(heading.children);
  const checks = rest.filter((block) => block.type === "check");
  const last = rest.at(-1);

  if (checks.length === 0) {
    issues.push({
      code: "lesson/missing-check",
      message: `Step "${title}" must end with exactly one :::check block.`,
    });
    return null;
  }
  if (checks.length > 1) {
    issues.push({
      code: "lesson/multiple-checks",
      message: `Step "${title}" has ${String(checks.length)} checks; a step ends with exactly one.`,
    });
    return null;
  }
  if (last?.type !== "check") {
    issues.push({
      code: "lesson/check-not-last",
      message: `Step "${title}" must end with its check; move the text after the check before it.`,
    });
    return null;
  }
  return { id, heading: heading.children, body: rest.slice(0, -1), check: last };
}

function plainText(inlines: Inline[]): string {
  return inlines
    .map((inline) => {
      if ("value" in inline) return inline.value;
      if ("children" in inline) return plainText(inline.children);
      return " ";
    })
    .join("");
}
