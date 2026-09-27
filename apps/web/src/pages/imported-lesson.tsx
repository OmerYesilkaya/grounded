import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
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

  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-baseline gap-3 border-b px-6 py-3">
        <Link
          to="/tracks/$trackId"
          params={{ trackId }}
          className="text-sm text-subtle-foreground hover:text-foreground"
        >
          ← Track
        </Link>
        <p className="text-xs tracking-widest text-subtle-foreground uppercase">
          Last lesson · from your earlier setup · read-only
        </p>
      </header>
      {lesson.data ? (
        <iframe
          title={lesson.data.title}
          sandbox=""
          srcDoc={lesson.data.html}
          className="w-full flex-1 border-0"
        />
      ) : lesson.error ? (
        <p className="px-6 pt-8 text-sm text-destructive">
          {lesson.error instanceof ApiError ? lesson.error.message : "Couldn't load the lesson."}
        </p>
      ) : null}
    </main>
  );
}
