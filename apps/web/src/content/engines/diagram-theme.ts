import type { Theme } from "../environment";

/**
 * Every diagram colour in one place. Mermaid's classDef rejects rgba(), so translucent fills are
 * 8-digit hex. Values match the app's tokens in index.css.
 */
export const DIAGRAM_THEME = {
  dark: {
    background: "#17181b",
    node: "#1e2024",
    text: "#e6e4df",
    border: "#34373d",
    line: "#75736e",
    accent: "#e0a458",
    accentFill: "#e0a45830",
  },
  light: {
    background: "#f3f1ec",
    node: "#ebe8e1",
    text: "#22211e",
    border: "#d3cec3",
    line: "#8d8980",
    accent: "#b8741f",
    accentFill: "#b8741f1f",
  },
} satisfies Record<Theme, Record<string, string>>;
