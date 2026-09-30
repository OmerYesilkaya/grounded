import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PageBar } from "@/components/page-bar";
import { useT } from "@/i18n";
import { api, ApiError } from "@/lib/api";

interface ImportedLesson {
  title: string;
  source: string;
  html: string;
}

/**
 * The last lesson from the learner's earlier setup, exactly as it was. It is a whole HTML document we
 * didn't write, so it runs in an empty sandbox: no scripts, no same-origin access (its old ask widget
 * stays inert, as intended).
 */
export function ImportedLessonPage({ trackId }: { trackId: string }) {
  const lesson = useQuery({
    queryKey: ["imported-lesson", trackId],
    queryFn: () => api<ImportedLesson>(`/api/tracks/${trackId}/imported-lesson`),
    staleTime: Infinity,
  });
  const t = useT().track.imported;

  return (
    <main className="flex h-dvh flex-col">
      <PageBar
        start={
          <Link
            to="/tracks/$trackId"
            params={{ trackId }}
            className="touch-target relative px-1 text-sm whitespace-nowrap text-subtle-foreground hover:text-foreground"
          >
            {t.back}
          </Link>
        }
        end={
          <p className="truncate text-xs tracking-widest text-subtle-foreground uppercase">
            {t.label}
          </p>
        }
      />
      {lesson.data ? (
        <iframe
          title={lesson.data.title}
          sandbox=""
          srcDoc={lesson.data.html}
          className="w-full flex-1 border-0"
        />
      ) : lesson.error ? (
        <p className="px-6 pt-8 text-sm text-destructive">
          {lesson.error instanceof ApiError ? lesson.error.message : t.failed}
        </p>
      ) : null}
    </main>
  );
}
