import type { DiagramEngine, Theme } from "../environment";
import { DIAGRAM_THEME } from "./diagram-theme";

let counter = 0;
let initializedFor: Theme | null = null;

/** Mermaid, loaded on first use, in strict security mode (labels are sanitized, no scripts). */
export const mermaidDiagramEngine: DiagramEngine = {
  render: async (source, { highlight, theme }) => {
    const { default: mermaid } = await import("mermaid");
    const colors = DIAGRAM_THEME[theme];
    if (initializedFor !== theme) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        // Mermaid 12 defaults most diagrams to the "neo" look, which drops a light-grey shadow
        // under every node. Classic keeps nodes flat.
        look: "classic",
        fontFamily: "Montserrat, system-ui, sans-serif",
        themeVariables: {
          background: colors.background,
          primaryColor: colors.node,
          primaryTextColor: colors.text,
          primaryBorderColor: colors.border,
          lineColor: colors.line,
          secondaryColor: colors.node,
          tertiaryColor: colors.background,
          edgeLabelBackground: colors.background,
          fontSize: "14px",
        },
        flowchart: { curve: "basis", padding: 14, nodeSpacing: 36, rankSpacing: 44 },
      });
      initializedFor = theme;
    }
    const highlightLines = highlight
      ? `\n  classDef hl fill:${colors.accentFill},stroke:${colors.accent},color:${colors.text},stroke-width:1.5px\n  class ${highlight} hl`
      : "";
    counter += 1;
    const { svg } = await mermaid.render(`diagram-${String(counter)}`, source + highlightLines);
    return svg;
  },
};
