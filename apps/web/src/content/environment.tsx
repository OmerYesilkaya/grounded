import { createContext, useContext, useMemo, type ReactNode } from "react";
import { vegaChartEngine } from "./engines/vega";
import { mermaidDiagramEngine } from "./engines/mermaid";
import { useTheme } from "@/lib/theme";

export type Theme = "dark" | "light";

/** Turns diagram source into SVG. Swappable per syntax (design §6.2); rejects on invalid source. */
export interface DiagramEngine {
  render: (source: string, options: { highlight: string | null; theme: Theme }) => Promise<string>;
}

/** Draws a chart spec into an element; resolves to a cleanup function. */
export interface ChartEngine {
  mount: (element: HTMLElement, spec: Record<string, unknown>, theme: Theme) => Promise<() => void>;
}

interface ContentEnvironment {
  diagrams: DiagramEngine;
  charts: ChartEngine;
  theme: Theme;
}

const ContentContext = createContext<ContentEnvironment>({
  diagrams: mermaidDiagramEngine,
  charts: vegaChartEngine,
  theme: "dark",
});

export function ContentProvider(props: {
  diagrams?: DiagramEngine | undefined;
  charts?: ChartEngine | undefined;
  theme?: Theme | undefined;
  children: ReactNode;
}) {
  const { diagrams, charts, theme, children } = props;
  // Diagrams and charts draw in the page's theme unless told otherwise (design §9.3).
  const pageTheme = useTheme();
  const value = useMemo(
    () => ({
      diagrams: diagrams ?? mermaidDiagramEngine,
      charts: charts ?? vegaChartEngine,
      theme: theme ?? pageTheme,
    }),
    [diagrams, charts, theme, pageTheme],
  );
  return <ContentContext value={value}>{children}</ContentContext>;
}

export function useContentEnvironment(): ContentEnvironment {
  return useContext(ContentContext);
}
