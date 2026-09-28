import type { ChartEngine } from "../environment";
import { DIAGRAM_THEME } from "./diagram-theme";

/** Vega-Lite through vega-embed, loaded on first use; no export menu. */
export const vegaChartEngine: ChartEngine = {
  mount: async (element, spec, theme) => {
    const { default: embed } = await import("vega-embed");
    const colors = DIAGRAM_THEME[theme];
    const result = await embed(element, spec, {
      actions: false,
      renderer: "svg",
      config: {
        background: "transparent",
        font: "Montserrat, system-ui, sans-serif",
        axis: {
          labelColor: colors.text,
          titleColor: colors.text,
          gridColor: colors.border,
          domainColor: colors.line,
        },
        legend: { labelColor: colors.text, titleColor: colors.text },
        title: { color: colors.text },
        range: { category: [colors.accent, colors.line, colors.text] },
        mark: { color: colors.accent },
      },
    });
    return () => {
      result.finalize();
    };
  },
};
