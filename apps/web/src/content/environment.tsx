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

export interface ResolvedMedia {
  url: string;
  credit?: string;
  license?: string;
}

/** Maps a tool ref to a verified URL. The server verifies media; unknown refs resolve to null. */
export type MediaResolver = (ref: string, kind: "image" | "audio") => ResolvedMedia | null;

interface ContentEnvironment {
  diagrams: DiagramEngine;
  charts: ChartEngine;
  media: MediaResolver;
  theme: Theme;
}

const noMedia: MediaResolver = () => null;

const ContentContext = createContext<ContentEnvironment>({
  diagrams: mermaidDiagramEngine,
  charts: vegaChartEngine,
  media: noMedia,
  theme: "dark",
});

export function ContentProvider(props: {
  diagrams?: DiagramEngine | undefined;
  charts?: ChartEngine | undefined;
  media?: MediaResolver | undefined;
  theme?: Theme | undefined;
  children: ReactNode;
}) {
  const { diagrams, charts, media, theme, children } = props;
  // Diagrams and charts draw in the page's theme unless told otherwise (design §9.3).
  const pageTheme = useTheme();
  const value = useMemo(
    () => ({
      diagrams: diagrams ?? mermaidDiagramEngine,
      charts: charts ?? vegaChartEngine,
      media: media ?? noMedia,
      theme: theme ?? pageTheme,
    }),
    [diagrams, charts, media, theme, pageTheme],
  );
  return <ContentContext value={value}>{children}</ContentContext>;
}

export function useContentEnvironment(): ContentEnvironment {
  return useContext(ContentContext);
}
