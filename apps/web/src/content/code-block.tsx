import { useEffect, useState } from "react";

/**
 * Plain code first, highlighted once Shiki has loaded (it lives in its own chunk). Shiki escapes the
 * code it highlights, so its HTML carries no model-written markup.
 */
export function CodeBlock({ code, lang }: { code: string; lang: string | null }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void import("shiki")
      .then(({ codeToHtml }) =>
        codeToHtml(code, {
          lang: lang ?? "text",
          themes: { dark: "github-dark-default", light: "github-light-default" },
          defaultColor: false,
        }),
      )
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch(() => {
        // Unknown language or a failed load: the plain code stays.
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  return (
    <figure className="my-5 overflow-hidden rounded-lg border bg-card">
      {lang && (
        <figcaption className="border-b px-3 py-1.5 font-sans text-xs text-subtle-foreground">
          {lang}
        </figcaption>
      )}
      {html ? (
        <div
          className="shiki-wrap overflow-x-auto p-4 text-sm"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto p-4 text-sm">
          <code>{code}</code>
        </pre>
      )}
    </figure>
  );
}
